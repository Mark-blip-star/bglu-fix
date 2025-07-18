/**
 * This is the main server script that provides the API endpoints
 *
 */
const fastify = require("fastify")({
  // Set this to true for detailed logging:
  logger: false,
});
let lastLluRequestTs = 0;
const MIN_DELAY_SEC = 5 * 60;
const bgllu2RateLimit = new Map(); // key: ip, value: lastTs
const BGLLU2_LIMIT_SEC = 300;
const request = require("request");
const request2 = require("request-promise");
const dexcom = require("dexcom-share-api");
const crypto = require("crypto");

function epochTime2(dt) {
  return Math.round(dt.getTime() / 1000);
}

/// format as YYYY-MM-YY
function dateToString(date) {
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return date.getFullYear().toString() + "-" + month + "-" + day;
}

function epochTime() {
  return Math.round(new Date().getTime() / 1000);
}

// OnRoute hook to list endpoints
const routes = { endpoints: [] };
fastify.addHook("onRoute", (routeOptions) => {
  routes.endpoints.push(routeOptions.method + " " + routeOptions.path);
});

// =======================================================================
// Read from Nightscout (1 person)
fastify.get("/bgdata4", (req, reply) => {
  const urls = [
    "/api/v2/properties/iob/entries.json?token=",
    "/api/v2/properties/cob/entries.json?token=",
    "/api/v1/entries.json?count=576&token=",
    "/api/v2/properties/upbat/?token=",
  ];
  let completed_requests = 0;
  let sgv = null;
  let dir = null;
  let delta = null;
  let sgvTs = null;
  let iob = null;
  let iobTs = null;
  let cob = null;
  let cobTs = null;
  let upbat = null;
  let avg = null;
  const hist = [];
  let tir = [0, 0, 0];

  for (let i = 0; i < urls.length; i++) {
    const url = trimBackslash(req.query.srv) + urls[i] + req.query.key;
    request.get(url, (error, response, body) => {
      completed_requests++;
      if (error) {
        console.dir(error);
        reply.code(500).send("err");
        return;
      }
      if (response.statusCode === 200) {
        const x = JSON.parse(response.body);
        // IOB
        if (x.iob != null) {
          iob = x.iob.iob;
          iobTs =
            x.iob.mills != null ? Math.floor(x.iob.mills / 1000) : epochTime();
        }
        // COB
        if (x.cob != null) {
          cob = x.cob.cob;
          cobTs =
            x.cob.mills != null ? Math.floor(x.cob.mills / 1000) : epochTime();
        }
        // BG data, delta, history
        if (x[0] != null) {
          sgv = x[0].sgv != null ? x[0].sgv : x[0].mbg;
          dir = x[0].direction;
          sgvTs = Math.floor(x[0].date / 1000);
          if (x[1] != null) {
            let nxt = x[1];
            if (nxt.date === x[0].date && x[2] != null) {
              nxt = x[2];
            }
            if (x[0].date - nxt.date <= 10 * 60 * 1000) {
              let nxtBG = nxt.sgv != null ? nxt.sgv : nxt.mbg;
              delta = sgv - nxtBG;
            }
          }
          const endIdx = x.length > 48 ? 46 : x.length - 1;
          let lastTS = 0;
          const twoHoursPrior = (epochTime() - 2 * 3600) * 1000;
          for (let j = endIdx; j >= 0; j--) {
            if (x[j].date >= twoHoursPrior) {
              let bg = x[j].sgv != null ? x[j].sgv : x[j].mbg;
              if (bg != null) {
                const ts = Math.floor(x[j].date / 1000);
                if (x[j].date !== lastTS) {
                  hist.push([ts, bg]);
                }
              }
            }
            lastTS = x[j].date;
          }
          const oneDayPrior = (epochTime() - 24 * 3600) * 1000;
          let accum = 0;
          let count = 0;
          lastTS = 0;
          for (let j = x.length - 1; j >= 0; j--) {
            if (x[j].date !== lastTS && lastTS !== 0) {
              if (x[j].date >= oneDayPrior) {
                let bg = x[j].sgv != null ? x[j].sgv : x[j].mbg;
                if (bg != null) {
                  accum += bg;
                  count++;
                  const dTime = x[j].date - lastTS;
                  if (bg <= req.query.tu && bg >= req.query.tl) {
                    tir[0] += dTime;
                  } else if (bg <= req.query.du && bg >= req.query.dl) {
                    tir[1] += dTime;
                  } else {
                    tir[2] += dTime;
                  }
                }
              }
            }
            lastTS = x[j].date;
          }
          for (let k = 0; k < 3; k++) {
            tir[k] = Math.round(tir[k] / 60000);
          }
          avg = count > 0 ? Math.round(accum / count) : null;
        }
        if (x.upbat != null) {
          let u = "";
          for (let k = 0; k < x.upbat.display.length; k++) {
            const c = x.upbat.display.charAt(k);
            if (c === "?") {
              upbat = 0;
              break;
            } else if (c !== "%") {
              u += c;
            } else {
              upbat = Number(u);
              break;
            }
          }
        }
      }
      if (completed_requests === urls.length) {
        const jsonObj = {
          sgvTs,
          sgv,
          dir,
          delta,
          iobTs,
          iob,
          cobTs,
          cob,
          upbat,
          hist,
          tir,
          avg,
        };
        reply.code(200).send(jsonObj);
      }
    });
  }
});

function trimBackslash(u) {
  let s = u.toLowerCase();
  if (!(s.startsWith("https://") || s.startsWith("http://"))) {
    s = "https://" + s;
  }
  if (s.endsWith("/")) {
    return s.slice(0, -1);
  }
  return s;
}

// =======================================================================
fastify.get("/bgdex", async (request, reply) => {
  const { id: username, p: password, srv, tu, tl, du, dl } = request.query;
  const client = new dexcom.DexcomClient({ username, password, server: srv });
  try {
    const data = await client.getEstimatedGlucoseValues({
      maxCount: 288,
      minutes: 1440,
    });
    if (!data || data.length === 0) {
      return reply.code(404).send({
        success: false,
        code: 404,
        message: "No glucose data available",
        step: "fetch",
      });
    }
    //
    let sgv = null,
      dir = null,
      delta = null,
      sgvTs = null;
    let iob = null,
      iobTs = null,
      cob = null,
      cobTs = null;
    let upbat = 0,
      hist = null,
      avg = null;
    let tir = [0, 0, 0];
    if (data[0] != null) {
      sgv = data[0].mgdl;
      dir = data[0].trend;
      sgvTs = Math.floor(data[0].timestamp / 1000);
      if (
        data[1] != null &&
        data[0].timestamp - data[1].timestamp <= 10 * 60 * 1000
      ) {
        delta = data[0].mgdl - data[1].mgdl;
      }
      const h = [];
      const endIdx = data.length > 24 ? 23 : data.length - 1;
      for (let k = endIdx; k >= 0; k--) {
        h.push([Math.floor(data[k].timestamp / 1000), data[k].mgdl]);
      }
      hist = h;
    }
    let accum = 0;
    let cnt = 0;
    const oneDayPrior = (epochTime() - 24 * 3600) * 1000;
    for (let k = data.length - 1; k >= 0; k--) {
      const value = data[k].mgdl;
      const ts = data[k].timestamp;
      if (ts >= oneDayPrior) {
        accum += value;
        cnt++;
        if (value <= tu && value >= tl) {
          tir[0] += 5;
        } else if (value <= du && value >= dl) {
          tir[1] += 5;
        } else {
          tir[2] += 5;
        }
      }
    }
    avg = cnt > 0 ? Math.round(accum / cnt) : null;
    return reply.code(200).send({
      success: true,
      sgvTs,
      sgv,
      dir,
      delta,
      iobTs,
      iob,
      cobTs,
      cob,
      upbat,
      hist,
      tir,
      avg,
    });
  } catch (error) {
    const code = error?.statusCode || 500;
    const retryAfter = error?.response?.headers?.["retry-after"];
    return reply.code(code).send({
      success: false,
      code,
      message:
        error?.error?.message || error?.message || "Dexcom request failed",
      step: "exception",
      ...(retryAfter ? { retryAfter } : {}),
    });
  }
});

fastify.get("/bgdex1", function (request, reply) {
  const client = new dexcom.DexcomClient({
    username: request.query.id,
    password: request.query.p,
    server: request.query.srv,
  });
  client
    .getEstimatedGlucoseValues({ maxCount: 2, minutes: 60 })
    .then((data) => {
      let sgv = null;
      let dir = null;
      let delta = null;
      let sgvTs = null;
      if (data[0] != null) {
        sgv = data[0].mgdl;
        dir = data[0].trend;
        sgvTs = data[0].timestamp;
        if (
          data[1] != null &&
          data[0].timestamp - data[1].timestamp <= 10 * 60 * 1000
        ) {
          delta = data[0].mgdl - data[1].mgdl;
        }
      }
      const arr = [
        {
          date: sgvTs,
          sgv: sgv,
          direction: dir,
          delta: delta,
        },
      ];
      reply.code(200).send(arr);
    })
    .catch((error) => {
      const code = error.statusCode || 500;
      reply.code(code).send({
        code,
        message: error.error || error.message || "Dexcom request failed",
        step: "exception",
      });
    });
});

function epochTimeD(dateIn) {
  return Math.round(dateIn.getTime() / 1000);
}

// =======================================================================
fastify.get("/bgdual", (request, reply) => {
  const sgv = [null, null];
  const dir = [null, null];
  const delta = [null, null];
  const sgvTs = [null, null];
  const iob = [null, null];
  const iobTs = [null, null];
  const cob = [null, null];
  const cobTs = [null, null];
  const upbat = [0, 0];
  const hist = [null, null];
  const avg = [null, null];
  const tir = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  const srv1 = trimBackslash(request.query.srv1);
  const srv2 = trimBackslash(request.query.srv2);
  const urls = [
    `${srv1}/api/v1/entries.json?count=288&token=${request.query.key1}`,
    `${srv2}/api/v1/entries.json?count=288&token=${request.query.key2}`,
    `${srv1}/api/v2/properties/iob/entries.json?token=${request.query.key1}`,
    `${srv2}/api/v2/properties/iob/entries.json?token=${request.query.key2}`,
    `${srv1}/api/v2/properties/cob/entries.json?token=${request.query.key1}`,
    `${srv2}/api/v2/properties/cob/entries.json?token=${request.query.key2}`,
    `${srv1}/api/v2/properties/upbat/?token=${request.query.key1}`,
    `${srv2}/api/v2/properties/upbat/?token=${request.query.key2}`,
  ];
  const promises = urls.map((url) => request2(url));
  Promise.all(promises)
    .then((results) => {
      for (let i = 0; i < 4; i++) {
        const data1 = JSON.parse(results[i * 2]);
        const data2 = JSON.parse(results[i * 2 + 1]);
        for (let j = 0; j < 2; j++) {
          const data = j === 0 ? data1 : data2;
          switch (i) {
            case 0:
              if (data[0] != null) {
                sgv[j] = data[0].sgv;
                dir[j] = data[0].direction;
                sgvTs[j] = Math.floor(data[0].date / 1000);
                if (
                  data[1] != null &&
                  data[0].date - data[1].date <= 10 * 60 * 1000
                ) {
                  delta[j] = data[0].sgv - data[1].sgv;
                }
                const h = [];
                const endIdx = data.length > 24 ? 23 : data.length - 1;
                for (let k = endIdx; k >= 0; k--) {
                  h.push([Math.floor(data[k].date / 1000), data[k].sgv]);
                }
                hist[j] = h;
              }
              let accum = 0;
              let cnt = 0;
              const oneDayPrior = (epochTime() - 24 * 3600) * 1000;
              for (let k = data.length - 1; k >= 0; k--) {
                if (data[k].date >= oneDayPrior) {
                  accum += data[k].sgv;
                  cnt++;
                  if (
                    data[k].sgv <= request.query.tu &&
                    data[k].sgv >= request.query.tl
                  ) {
                    tir[j][0] += 5;
                  } else if (
                    data[k].sgv <= request.query.du &&
                    data[k].sgv >= request.query.dl
                  ) {
                    tir[j][1] += 5;
                  } else {
                    tir[j][2] += 5;
                  }
                }
              }
              avg[j] = cnt > 0 ? Math.round(accum / cnt) : null;
              break;
            case 1: // IOB
              if (data.iob != null) {
                iob[j] = data.iob.iob;
                iobTs[j] =
                  data.iob.mills != null
                    ? Math.floor(data.iob.mills / 1000)
                    : epochTime();
              } else {
                iob[j] = null;
                iobTs[j] = null;
              }
              break;
            case 2: // COB
              if (data.cob != null) {
                cob[j] = data.cob.cob;
                cobTs[j] =
                  data.cob.mills != null
                    ? Math.floor(data.cob.mills / 1000)
                    : epochTime();
              } else {
                cob[j] = null;
                cobTs[j] = null;
              }
              break;
            case 3:
              if (
                data.upbat != null &&
                typeof data.upbat.display === "string"
              ) {
                let u = "";
                for (let k = 0; k < data.upbat.display.length; k++) {
                  const c = data.upbat.display.charAt(k);
                  if (c === "?") {
                    upbat[j] = 0;
                    break;
                  } else if (c !== "%") {
                    u += c;
                  } else {
                    upbat[j] = Number(u);
                    break;
                  }
                }
              }
              break;
          }
        }
      }
      reply.code(200).send({
        sgvTs,
        sgv,
        dir,
        delta,
        iobTs,
        iob,
        cobTs,
        cob,
        upbat,
        hist,
        tir,
        avg,
      });
    })
    .catch((error) => {
      const code = error.statusCode || 500;
      reply.code(code).send({
        code,
        message: error.error?.message || error.message || "Unexpected error",
        step: "exception",
      });
    });
});

fastify.get("/bgdex2", async (request, reply) => {
  const { id1, p1, id2, p2, srv, tu, tl, du, dl } = request.query;
  const getDexcomData = async (username, password) => {
    const client = new dexcom.DexcomClient({ username, password, server: srv });
    const data = await client.getEstimatedGlucoseValues({
      maxCount: 288,
      minutes: 1440,
    });
    if (!Array.isArray(data) || data.length === 0) {
      const err = new Error("No glucose data");
      err.step = "glucose-fetch";
      err.statusCode = 404;
      throw err;
    }
    const sgv = data[0]?.mgdl ?? null;
    const dir = data[0]?.trend ?? null;
    const sgvTs = data[0]?.timestamp
      ? Math.floor(data[0].timestamp / 1000)
      : null;
    let delta = null;
    if (data[1] && data[0].timestamp - data[1].timestamp <= 10 * 60 * 1000) {
      delta = data[0].mgdl - data[1].mgdl;
    }
    const hist = [];
    const endIdx = data.length > 24 ? 23 : data.length - 1;
    for (let k = endIdx; k >= 0; k--) {
      hist.push([Math.floor(data[k].timestamp / 1000), data[k].mgdl]);
    }
    let accum = 0;
    let cnt = 0;
    const tir = [0, 0, 0];
    const oneDayPrior = (epochTime() - 24 * 3600) * 1000;
    for (const entry of data) {
      if (entry.timestamp >= oneDayPrior) {
        accum += entry.mgdl;
        cnt++;
        if (entry.mgdl >= tl && entry.mgdl <= tu) {
          tir[0] += 5;
        } else if (entry.mgdl >= dl && entry.mgdl <= du) {
          tir[1] += 5;
        } else {
          tir[2] += 5;
        }
      }
    }
    const avg = cnt > 0 ? Math.round(accum / cnt) : null;
    return {
      sgvTs,
      sgv,
      dir,
      delta,
      iob: null,
      iobTs: null,
      cob: null,
      cobTs: null,
      upbat: 0,
      hist,
      tir,
      avg,
    };
  };

  try {
    const results = await Promise.allSettled([
      getDexcomData(id1, p1),
      getDexcomData(id2, p2),
    ]);
    const sgvTs = [null, null];
    const sgv = [null, null];
    const dir = [null, null];
    const delta = [null, null];
    const iob = [null, null];
    const iobTs = [null, null];
    const cob = [null, null];
    const cobTs = [null, null];
    const upbat = [0, 0];
    const hist = [null, null];
    const tir = [
      [0, 0, 0],
      [0, 0, 0],
    ];
    const avg = [null, null];
    let error = null;
    let outputCode = 200;
    results.forEach((res, idx) => {
      if (res.status === "fulfilled") {
        const data = res.value;
        sgvTs[idx] = data.sgvTs;
        sgv[idx] = data.sgv;
        dir[idx] = data.dir;
        delta[idx] = data.delta;
        iob[idx] = data.iob;
        iobTs[idx] = data.iobTs;
        cob[idx] = data.cob;
        cobTs[idx] = data.cobTs;
        upbat[idx] = data.upbat;
        hist[idx] = data.hist;
        tir[idx] = data.tir;
        avg[idx] = data.avg;
      } else {
        const e = res.reason;
        if (!error) {
          error = {
            code: e.statusCode || 500,
            message: e.message || "Data fetch failed",
            step: e.step || "exception",
          };
          outputCode = error.code;
        }
      }
    });
    if (error) {
      return reply.code(outputCode).send({
        code: outputCode,
        message: error.message,
        step: error.step,
        sgvTs,
        sgv,
        dir,
        delta,
        iobTs,
        iob,
        cobTs,
        cob,
        upbat,
        hist,
        tir,
        avg,
      });
    } else {
      return reply.code(200).send({
        code: 200,
        sgvTs,
        sgv,
        dir,
        delta,
        iobTs,
        iob,
        cobTs,
        cob,
        upbat,
        hist,
        tir,
        avg,
      });
    }
  } catch (err) {
    const code = err.statusCode || 500;
    return reply.code(code).send({
      code,
      message: err.message || "Unexpected fatal error",
      step: "fatal",
    });
  }
});

fastify.get("/bgllu", async (req, reply) => {
  const now = Math.floor(Date.now() / 1000);
  if (now - lastLluRequestTs < MIN_DELAY_SEC) {
    return reply.code(429).send({
      success: false,
      code: 429,
      message: `Rate limit exceeded. Try again after ${
        MIN_DELAY_SEC - (now - lastLluRequestTs)
      } seconds.`,
      step: "rate-limit",
    });
  }
  lastLluRequestTs = now;
  const { id: email, p: password, srv, noHist } = req.query;
  const agent = "PostmanRuntime/7.43.0";
  const product = "llu.android";
  const version = "4.12.0";
  let server = getLluServer(srv);
  try {
    let loginResp = await request2({
      method: "POST",
      uri: `${server}/llu/auth/login`,
      headers: {
        product,
        version,
        "Content-Type": "application/json",
        accept: "*/*",
        "User-Agent": agent,
      },
      body: { email, password },
      json: true,
    });
    if (loginResp.data?.redirect) {
      const region = loginResp.data.region;
      server =
        region === "ru"
          ? "https://api.libreview.ru"
          : `https://api-${region}.libreview.io`;
      const loginResp2 = await request2({
        method: "POST",
        uri: `${server}/llu/auth/login`,
        headers: {
          product,
          version,
          "Content-Type": "application/json",
          accept: "*/*",
          "User-Agent": agent,
        },
        body: { email, password },
        json: true,
      });
      loginResp = loginResp2;
    }
    if (!loginResp.data?.authTicket || !loginResp.data.user) {
      return reply.code(401).send({
        success: false,
        code: 401,
        message: "Invalid login response",
        step: "auth",
      });
    }
    const token = loginResp.data.authTicket.token;
    const userId = loginResp.data.user.id;
    const accountId = crypto.createHash("sha256").update(userId).digest("hex");
    const connResp = await request2({
      method: "GET",
      uri: `${server}/llu/connections`,
      headers: {
        product,
        version,
        "Account-Id": accountId,
        Authorization: `Bearer ${token}`,
        accept: "*/*",
        "User-Agent": agent,
        "cache-control": "no-cache",
      },
      json: true,
    });
    if (!Array.isArray(connResp.data) || connResp.data.length === 0) {
      return reply.code(404).send({
        success: false,
        code: 404,
        message: "No connection data found",
        step: "connections",
      });
    }
    const patientId = connResp.data[0].patientId;
    const graphResp = await request2({
      method: "GET",
      uri: `${server}/llu/connections/${patientId}/graph`,
      headers: {
        product,
        version,
        "Account-Id": accountId,
        Authorization: `Bearer ${token}`,
        accept: "*/*",
        "User-Agent": agent,
        "cache-control": "no-cache",
      },
      json: true,
    });
    const meas = graphResp.data?.connection?.glucoseMeasurement;
    if (!meas) {
      return reply.code(404).send({
        success: false,
        code: 404,
        message: "No glucose data found",
        step: "graph",
      });
    }
    const sgvTs = epochTimeD(new Date(meas.FactoryTimestamp));
    const sgv = meas.ValueInMgPerDl;
    const dir = getTrendDesc(meas.TrendArrow);
    let delta;
    const nowTs = epochTimeD(new Date());
    const graphData = graphResp.data.graphData ?? [];
    const hist = [];
    for (let j = 0; j < graphData.length; j++) {
      const entry = graphData[j];
      const ts = epochTimeD(new Date(entry.FactoryTimestamp));
      if (!noHist && nowTs - ts < 7500) {
        hist.push([ts, entry.ValueInMgPerDl]);
      }
      if (ts === sgvTs && j > 0) {
        delta = entry.ValueInMgPerDl - graphData[j - 1].ValueInMgPerDl;
      }
    }
    const result = {
      success: true,
      sgvTs,
      sgv,
      dir,
      delta,
    };
    if (!noHist) {
      result.hist = hist;
    }
    return reply.code(200).send(result);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    const retryAfter = err.response?.headers?.["retry-after"];
    return reply.code(statusCode).send({
      success: false,
      code: statusCode,
      message: err.message || "Unexpected error",
      step: "exception",
      ...(retryAfter ? { retryAfter } : {}),
    });
  }
});

function getLluServer(srv) {
  let server = "https://api.libreview.io";
  if (srv != null) {
    switch (Number(srv)) {
      case 0:
        server = "https://api.libreview.io";
        break; // US
      case 1:
        server = "https://api-eu.libreview.io";
        break; // EU
      case 2:
        server = "https://api-de.libreview.io";
        break; // Germany
      case 3:
        server = "https://api-ap.libreview.io";
        break; // AP (Singapore)
      case 4:
        server = "https://api-la.libreview.io";
        break; // Latin America
      case 5:
        server = "https://api.libreview.ru";
        break; // Russia
    }
  }
  return server;
}

function getTrendDesc(trendArrow) {
  switch (Number(trendArrow)) {
    case 1:
      return "SingleDown";
    case 2:
      return "FortyFiveDown";
    case 3:
      return "Flat";
    case 4:
      return "FortyFiveUp";
    case 5:
      return "SingleUp";
    default:
      return "NotDetermined";
  }
}

fastify.get("/bgllu2", async (req, reply) => {
  const ip = req.ip;
  const now = Math.floor(Date.now() / 1000);
  const lastTs = bgllu2RateLimit.get(ip) || 0;
  if (now - lastTs < BGLLU2_LIMIT_SEC) {
    return reply.code(429).send({
      code: 429,
      message: `Rate limit exceeded. Try again after ${
        BGLLU2_LIMIT_SEC - (now - lastTs)
      } seconds.`,
      step: "rate-limit",
    });
  }
  bgllu2RateLimit.set(ip, now);
  const agent = "PostmanRuntime/7.43.0";
  const product = "llu.android";
  const version = "4.12.0";
  const server = getLluServer(req.query.srv);
  const inputCreds = [
    { email: req.query.id1, password: req.query.p1 },
    { email: req.query.id2, password: req.query.p2 },
  ];
  const sgvTs = [null, null];
  const sgv = [null, null];
  const dir = [null, null];
  const delta = [null, null];
  const iob = [null, null];
  const iobTs = [null, null];
  const cob = [null, null];
  const cobTs = [null, null];
  const upbat = [0, 0];
  const hist = [null, null];
  const avg = [null, null];
  const tir = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  let firstError = null;
  try {
    const results = await Promise.allSettled(
      inputCreds.map(({ email, password }) =>
        fetchLluUserData(email, password, server, agent, product, version)
      )
    );
    results.forEach((res, idx) => {
      if (res.status === "fulfilled") {
        const data = res.value;
        sgvTs[idx] = data.sgvTs;
        sgv[idx] = data.sgv;
        dir[idx] = data.dir;
        delta[idx] = data.delta;
        hist[idx] = data.hist;
      } else {
        const e = res.reason;
        if (!firstError) {
          firstError = {
            code: e.statusCode || 500,
            message: e.message || "Unexpected error",
            step: e.step || "exception",
          };
        }
      }
    });
    if (firstError) {
      return reply.code(firstError.code).send({
        code: firstError.code,
        message: firstError.message,
        step: firstError.step,
        sgvTs,
        sgv,
        dir,
        delta,
        iobTs,
        iob,
        cobTs,
        cob,
        upbat,
        hist,
        tir,
        avg,
      });
    }
    return reply.code(200).send({
      code: 200,
      sgvTs,
      sgv,
      dir,
      delta,
      iobTs,
      iob,
      cobTs,
      cob,
      upbat,
      hist,
      tir,
      avg,
    });
  } catch (err) {
    const code = err.statusCode || 500;
    return reply.code(code).send({
      code,
      message: err.message || "Fatal exception",
      step: "fatal",
    });
  }
});

async function fetchLluUserData(
  email,
  password,
  server,
  agent,
  product,
  version
) {
  let currentServer = server;
  const loginResp = await request2({
    method: "POST",
    uri: `${currentServer}/llu/auth/login`,
    headers: {
      product,
      version,
      "Content-Type": "application/json",
      accept: "*/*",
      "User-Agent": agent,
    },
    body: { email, password },
    json: true,
  });
  if (loginResp.data?.redirect) {
    const region = loginResp.data.region;
    currentServer =
      region === "ru"
        ? "https://api.libreview.ru"
        : `https://api-${region}.libreview.io`;
    const loginResp2 = await request2({
      method: "POST",
      uri: `${currentServer}/llu/auth/login`,
      headers: {
        product,
        version,
        "Content-Type": "application/json",
        accept: "*/*",
        "User-Agent": agent,
      },
      body: { email, password },
      json: true,
    });
    if (!loginResp2.data?.authTicket) {
      const err = new Error("Login failed after redirect");
      err.statusCode = loginResp2.status || 401;
      err.step = "auth";
      throw err;
    }
    loginResp.data = loginResp2.data;
  }
  if (!loginResp.data?.authTicket || !loginResp.data.user) {
    const err = new Error("Login failed");
    err.statusCode = loginResp.statusCode || 401;
    err.step = "auth";
    throw err;
  }
  const token = loginResp.data.authTicket.token;
  const userId = loginResp.data.user.id;
  const accountId = crypto.createHash("sha256").update(userId).digest("hex");
  const connResp = await request2({
    method: "GET",
    uri: `${currentServer}/llu/connections`,
    headers: {
      product,
      version,
      "Account-Id": accountId,
      Authorization: `Bearer ${token}`,
      accept: "*/*",
      "User-Agent": agent,
      "cache-control": "no-cache",
    },
    json: true,
  });
  if (!Array.isArray(connResp.data) || connResp.data.length === 0) {
    const err = new Error("No connection data");
    err.statusCode = 404;
    err.step = "connections";
    throw err;
  }
  const patientId = connResp.data[0].patientId;
  const graphResp = await request2({
    method: "GET",
    uri: `${currentServer}/llu/connections/${patientId}/graph`,
    headers: {
      product,
      version,
      "Account-Id": accountId,
      Authorization: `Bearer ${token}`,
      accept: "*/*",
      "User-Agent": agent,
      "cache-control": "no-cache",
    },
    json: true,
  });
  if (!graphResp.data?.connection?.glucoseMeasurement) {
    const err = new Error("No glucose data");
    err.statusCode = 404;
    err.step = "graph";
    throw err;
  }
  const meas = graphResp.data.connection.glucoseMeasurement;
  const sgvTs = epochTimeD(new Date(meas.FactoryTimestamp));
  const sgv = meas.ValueInMgPerDl;
  const dir = getTrendDesc(meas.TrendArrow);
  let delta = null;
  const nowTs = epochTimeD(new Date());
  const hist = [];
  const graphData = graphResp.data.graphData || [];
  for (let j = 0; j < graphData.length; j++) {
    const entry = graphData[j];
    const ts = epochTimeD(new Date(entry.FactoryTimestamp));
    if (nowTs - ts < 7500) {
      hist.push([ts, entry.ValueInMgPerDl]);
    }
    if (ts === sgvTs && j > 0) {
      delta = entry.ValueInMgPerDl - graphData[j - 1].ValueInMgPerDl;
    }
  }
  return {
    sgvTs,
    sgv,
    dir,
    delta,
    iob: null,
    iobTs: null,
    cob: null,
    cobTs: null,
    upbat: 0,
    hist,
    avg: null,
    tir: [0, 0, 0],
  };
}

// ======================================================================
fastify.listen(
  { port: process.env.PORT, host: "0.0.0.0" },
  function (err, address) {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log("Your app is listening on " + address);
  }
);
