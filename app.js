/**
 * This is the main server script that provides the API endpoints
 *
 */

const fastify = require("fastify")({
  // Set this to true for detailed logging:
  logger: false,
});
let lastLluRequestTs = 0;
const MIN_DELAY = 5 * 60;
const bgllu2RateLimit = new Map(); // key: ip, value: lastTs
const BGLLU2_LIMIT_SEC = 300;
const request = require("request");
const request2 = require("request-promise");
const dexcom = require("dexcom-share-api");
// node.js built in crypto module
const crypto = require("crypto");

function epochTime2(dt) {
  const secondsSinceEpoch = Math.round(dt.getTime() / 1000);
  return secondsSinceEpoch;
}

/// format as YYYY-MM-YY
function dateToString(date) {
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return date.getFullYear().toString() + "-" + month + "-" + day;
}

function epochTime() {
  const now = new Date();
  const secondsSinceEpoch = Math.round(now.getTime() / 1000);
  return secondsSinceEpoch;
}
// -----------------------------------------------------

// OnRoute hook to list endpoints
const routes = { endpoints: [] };
fastify.addHook("onRoute", (routeOptions) => {
  routes.endpoints.push(routeOptions.method + " " + routeOptions.path);
});

// =======================================================================

// Read from Nightscout
// query parameters
// srv - server url
// key - api secret
// tu - target range upper limit
// tl - target range lower limit
// du - danger range upper limit
// dl - danger range lower limit
fastify.get("/bgdata4", (req, reply) => {
  var urls = [
    "/api/v2/properties/iob/entries.json?token=",
    "/api/v2/properties/cob/entries.json?token=",
    "/api/v1/entries.json?count=576&token=",
    "/api/v2/properties/upbat/?token=",
  ];
  var completed_requests = 0;
  var sgv = null;
  var dir = null;
  var delta = null;
  var sgvTs = null;
  var iob = null;
  var iobTs = null;
  var cob = null;
  var cobTs = null;
  var upbat = null;
  var avg = null;
  var hist = [];
  let tir = [0, 0, 0];

  for (var i = 0; i < urls.length; i++) {
    let url = trimBackslash(req.query.srv) + urls[i] + req.query.key;
    // console.dir(url);
    request.get(url, (error, response, body) => {
      //responses.push(response);
      // NOTE: RESPONSES MAY NOT BE IN THE ORDER OF THE REQUESTS !!
      completed_requests++;
      if (error) {
        console.dir(error);
        reply.send("err");
      }
      //console.dir(response.body);
      if (response.statusCode == 200) {
        // IOB
        let x = JSON.parse(response.body);
        if (x.iob != null) {
          iob = x.iob.iob;
          if (x.iob.mills != null) {
            iobTs = Math.floor(x.iob.mills / 1000);
          } else {
            iobTs = epochTime();
          }
        }
        // cob
        if (x.cob != null) {
          cob = x.cob.cob;
          if (x.cob.mills != null) {
            cobTs = Math.floor(x.cob.mills / 1000);
          } else {
            cobTs = epochTime();
          }
        }
        // BG data, delta, history
        if (x[0] != null) {
          sgv = x[0].sgv;
          if (sgv == null) {
            sgv = x[0].mbg; // try get manual BG
          }
          dir = x[0].direction;
          sgvTs = Math.floor(x[0].date / 1000);
          if (x[1] != null) {
            var nxt = x[1];
            if (nxt.date == x[0].date) {
              nxt = x[2];
            }
            const prevSgv = sgv;
            // if time diff is reasonable 10 minutes or less
            if (x[0].date - nxt.date <= 10 * 60 * 1000) {
              var nxtBG = nxt.sgv;
              if (nxtBG == null) {
                nxtBG = nxt.mbg;
              }
              delta = sgv - nxtBG;
            }
          }
          let endIdx = x.length > 48 ? 46 : x.length - 1;
          let lastTS = 0;
          const twoHoursPrior = (epochTime() - 2 * 3600) * 1000;
          for (var j = endIdx; j >= 0; j--) {
            if (x[j].date >= twoHoursPrior) {
              var bg = x[j].sgv;
              if (bg == null) {
                bg = x[j].mbg; // try get manual BG value
              }
              if (bg != null) {
                let elem = [Math.floor(x[j].date / 1000), bg];
                if (x[j].date != lastTS) {
                  hist.push(elem);
                }
              }
            }
            lastTS = x[j].date;
          }
          // calc time in ranges (3 ranges) and average
          const oneDayPrior = (epochTime() - 24 * 3600) * 1000;
          let accum = 0;
          let count = 0;
          lastTS = 0;

          for (var j = x.length - 1; j >= 0; j--) {
            if (x[j].date != lastTS && lastTS != 0) {
              if (x[j].date >= oneDayPrior) {
                var bg = x[j].sgv;
                if (bg == null) {
                  bg = x[j].mbg; // try get manual bg
                }
                if (bg != null) {
                  accum = accum + bg;
                  count++;
                  let dTime = x[j].date - lastTS; // time intervals can be uneven
                  if (bg <= req.query.tu && bg >= req.query.tl) {
                    tir[0] = tir[0] + dTime;
                  } else if (bg <= req.query.du && bg >= req.query.dl) {
                    tir[1] = tir[1] + dTime;
                  } else {
                    tir[2] = tir[2] + dTime;
                  }
                }
              }
            }
            lastTS = x[j].date;
          }
          // convert ms to min
          for (var i = 0; i < 3; i++) {
            tir[i] = Math.round(tir[i] / 60000);
          }
          avg = Math.round(accum / count);
        }
        // uploader battery
        if (x.upbat != null) {
          var u = "";
          for (var k = 0; k < x.upbat.display.length; k++) {
            // accumulate characters up to "%"
            const c = x.upbat.display.substring(k, k + 1);
            if (c == "?") {
              // "?%" case
              upbat = 0;
              break;
            } else {
              if (c != "%") {
                u = u + c;
              } else {
                upbat = Number(u);
                break;
              }
            }
          }
        }
      }
      if (completed_requests == urls.length) {
        const jsonObj = {
          sgvTs: sgvTs,
          sgv: sgv,
          dir: dir,
          delta: delta,
          iobTs: iobTs,
          iob: iob,
          cobTs: cobTs,
          cob: cob,
          upbat: upbat,
          hist: hist,
          tir: tir,
          avg: avg,
        };
        reply.status(200).send(jsonObj);
      }
    });
  }
});

// fix up URL, add missing https:// or remove ending /
function trimBackslash(u) {
  let s = u.toLowerCase();
  if (!(s.substring(0, 8) == "https://" || s.substring(0, 7) == "http://")) {
    s = "https://" + s;
  }
  if (s.substring(s.length - 1, s.length) == "/") {
    return s.substring(0, s.length - 1);
  } else {
    return s;
  }
}

fastify.get("/bgdex", async function (request, reply) {
  const { id: username, p: password, srv, tu, tl, du, dl } = request.query;

  const client = new dexcom.DexcomClient({
    username,
    password,
    server: srv,
  });

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

    let sgv = null,
      dir = null,
      delta = null,
      sgvTs = null,
      iob = null,
      iobTs = null,
      cob = null,
      cobTs = null,
      upbat = 0,
      hist = null,
      avg = null,
      tir = [0, 0, 0];

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

      let h = [];
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

        if (value <= tu && value >= tl) tir[0] += 5;
        else if (value <= du && value >= dl) tir[1] += 5;
        else tir[2] += 5;
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
// simplified - for TGC cgm
fastify.get("/bgdex1", function (request, reply) {
  // initialization
  const client = new dexcom.DexcomClient({
    username: request.query.id,
    password: request.query.p,
    // This server needs to be either "us" or "eu. If you're in the US, the server
    // should be "us". Any other country outside of the US (eg. Canada) is
    // classified as "eu" by Dexcom
    server: request.query.srv,
  });
  //client.getAccountId().then(console.log)
  //client.getSessionId().then(console.log)
  var sgv = null;
  var dir = null;
  var delta = null;
  var sgvTs = null;
  client
    .getEstimatedGlucoseValues({ maxCount: 2, minutes: 60 })
    .then((data) => {
      //console.log(data.length);
      //console.log(data);
      if (data[0] != null) {
        sgv = data[0].mgdl;
        dir = data[0].trend;
        sgvTs = data[0].timestamp;
        if (data[1] != null) {
          const prevSgv = data[0].mgdl;
          // if time diff is reasonable 10 minutes or less
          if (data[0].timestamp - data[1].timestamp <= 10 * 60 * 1000) {
            delta = data[0].mgdl - data[1].mgdl;
          }
        }
      }
      var arr = [];
      arr.push({
        date: sgvTs,
        sgv: sgv,
        direction: dir,
        delta: delta,
      });
      reply.status(200).send(arr);
    })
    .catch((error) => {
      console.log("error!");
      console.log(error);
      // An error occurred while performing the tasks, handle it here
      reply
        .status(error.statusCode)
        .send({ code: error.statusCode, error: error.error }); // temporary
    });
});

function epochTimeD(dateIn) {
  const secondsSinceEpoch = Math.round(dateIn.getTime() / 1000);
  return secondsSinceEpoch;
}

// ======================================================================

// 2 person NightScout version
fastify.get("/bgdual", (request, reply) => {
  var sgv = [null, null];
  var dir = [null, null];
  var delta = [null, null];
  var sgvTs = [null, null];
  var iob = [null, null];
  var iobTs = [null, null];
  var cob = [null, null];
  var cobTs = [null, null];
  var upbat = [0, 0];
  var hist = [null, null];
  var avg = [null, null];
  var tir = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  var srv1 = trimBackslash(request.query.srv1);
  var srv2 = trimBackslash(request.query.srv2);
  let urls = [
    srv1 + "/api/v1/entries.json?count=288&token=" + request.query.key1,
    srv2 + "/api/v1/entries.json?count=288&token=" + request.query.key2,
    srv1 + "/api/v2/properties/iob/entries.json?token=" + request.query.key1,
    srv2 + "/api/v2/properties/iob/entries.json?token=" + request.query.key2,
    srv1 + "/api/v2/properties/cob/entries.json?token=" + request.query.key1,
    srv2 + "/api/v2/properties/cob/entries.json?token=" + request.query.key2,
    srv1 + "/api/v2/properties/upbat/?token=" + request.query.key1,
    srv2 + "/api/v2/properties/upbat/?token=" + request.query.key2,
  ];
  const promises = urls.map((url) => request2(url));
  Promise.all(promises)
    .then((data) => {
      // data = [promise1,promise2]
      for (var i = 0; i < 4; i++) {
        // for each data type
        if (promises[i * 2].response.statusCode == 200) {
          let x = [
            JSON.parse(promises[i * 2].response.body),
            JSON.parse(promises[i * 2 + 1].response.body),
          ];
          for (var j = 0; j < 2; j++) {
            // for each server
            switch (i) {
              case 0: // BG values
                if (x[j][0] != null) {
                  sgv[j] = x[j][0].sgv;
                  dir[j] = x[j][0].direction;
                  sgvTs[j] = Math.floor(x[j][0].date / 1000);
                  if (x[j][1] != null) {
                    const prevSgv = x[j][0].sgv;
                    // if time diff is reasonable 10 minutes or less
                    if (x[j][0].date - x[j][1].date <= 10 * 60 * 1000) {
                      delta[j] = x[j][0].sgv - x[j][1].sgv;
                    }
                  }
                  var h = [];
                  let endIdx = x[j].length > 24 ? 23 : x[j].length - 1;
                  for (var k = endIdx; k >= 0; k--) {
                    let elem = [Math.floor(x[j][k].date / 1000), x[j][k].sgv];
                    h.push(elem);
                  }
                  hist[j] = h;
                }
                // calc time in ranges (3 ranges)
                var accum = 0;
                var cnt = 0;
                const oneDayPrior = (epochTime() - 24 * 3600) * 1000;
                for (var k = x[j].length - 1; k >= 0; k--) {
                  if (x[j][k].date >= oneDayPrior) {
                    accum += x[j][k].sgv;
                    cnt++;
                    if (
                      x[j][k].sgv <= request.query.tu &&
                      x[j][k].sgv >= request.query.tl
                    ) {
                      tir[j][0] += 5;
                    } else if (
                      x[j][k].sgv <= request.query.du &&
                      x[j][k].sgv >= request.query.dl
                    ) {
                      tir[j][1] += 5;
                    } else {
                      tir[j][2] += 5;
                    }
                  }
                }
                avg[j] = Math.round(accum / cnt);
                break;
              case 1: // IOB
                if (x[j].iob != null) {
                  iob[j] = x[j].iob.iob;
                  iobTs[j] =
                    x[j].iob.mills != null
                      ? Math.floor(x[j].iob.mills / 1000)
                      : epochTime();
                } else {
                  iob[j] = null;
                  iobTs[j] = null;
                }
                break;
              case 2: // COB
                if (x[j].cob != null) {
                  cob[j] = x[j].cob.cob;
                  cobTs[j] =
                    x[j].cob.mills != null
                      ? Math.floor(x[j].cob.mills / 1000)
                      : epochTime();
                } else {
                  cob[j] = null;
                  cobTs[j] = null;
                }
                break;
              case 3: // Uploader battery
                // uploader battery
                if (x[j].upbat != null) {
                  var u = "";
                  for (var k = 0; k < x[j].upbat.display.length; k++) {
                    // accumulate characters up to "%"
                    const c = x[j].upbat.display.substring(k, k + 1);
                    if (c == "?") {
                      // "?%" case
                      upbat[j] = 0;
                      break;
                    } else {
                      if (c != "%") {
                        u = u + c;
                      } else {
                        upbat[j] = Number(u);
                        break;
                      }
                    }
                  }
                }
            }
          }
        }
      }
      const jsonObj = {
        sgvTs: sgvTs,
        sgv: sgv,
        dir: dir,
        delta: delta,
        iobTs: iobTs,
        iob: iob,
        cobTs: cobTs,
        cob: cob,
        upbat: upbat,
        hist: hist,
        tir: tir,
        avg: avg,
      };
      reply.status(200).send(jsonObj);
    })
    .catch((error) => {
      console.log("error!");
      console.log(error);
      // An error occurred while performing the tasks, handle it here
      reply
        .status(error.statusCode)
        .send({ code: error.statusCode, error: error.error }); // temporary
    });
});

// 2 person Dexcom version
// query params id1, id2, p1, p2, srv, tu, tl, du, dl
fastify.get("/bgdex2", async (request, reply) => {
  const { id1, p1, id2, p2, srv, tu, tl, du, dl } = request.query;

  const makeClient = (username, password) =>
    new dexcom.DexcomClient({ username, password, server: srv });

  const getDexcomData = async (client) => {
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

    const hist = data
      .slice(0, Math.min(24, data.length))
      .map((d) => [Math.floor(d.timestamp / 1000), d.mgdl]);

    let accum = 0;
    let cnt = 0;
    const tir = [0, 0, 0];
    const oneDayPrior = (epochTime() - 86400) * 1000;

    for (const entry of data) {
      if (entry.timestamp < oneDayPrior) continue;
      accum += entry.mgdl;
      cnt++;

      if (entry.mgdl >= tl && entry.mgdl <= tu) tir[0] += 5;
      else if (entry.mgdl >= dl && entry.mgdl <= du) tir[1] += 5;
      else tir[2] += 5;
    }

    const avg = cnt > 0 ? Math.round(accum / cnt) : null;

    return {
      sgv,
      sgvTs,
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
      getDexcomData(makeClient(id1, p1)),
      getDexcomData(makeClient(id2, p2)),
    ]);

    let error = null;

    const res1 = results[0];
    const res2 = results[1];

    if (res1.status === "rejected" && res2.status === "rejected") {
      error = res1.reason || res2.reason;
    }

    return reply.code(error ? error.statusCode || 500 : 200).send({
      code: error ? error.statusCode || 500 : 200,
      message: error ? error.message || "Both requests failed" : "OK",
      step: error ? error.step || "dexcom" : undefined,
      data1: res1.status === "fulfilled" ? res1.value : null,
      data2: res2.status === "fulfilled" ? res2.value : null,
    });
  } catch (e) {
    return reply.code(500).send({
      code: 500,
      message: e.message || "Unexpected fatal error",
      step: "fatal",
    });
  }
});
// ===== Libre link up================================================================
/* Read from Libre LinkUp
  Added graph historical data
  Version with redirect handling
  request parameters: id:  email
                      p: password
                      srv: server
                      noHist=1: to exclude history                      
  Reference: https://gist.github.com/khskekec/6c13ba01b10d3018d816706a32ae8ab2
*/
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
  let token;
  let accountId;

  try {
    const loginOptions = {
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
    };

    let loginResp = await request(loginOptions);

    if (loginResp?.data?.redirect) {
      const region = loginResp.data.region;
      server =
        region === "ru"
          ? "https://api.libreview.ru"
          : `https://api-${region}.libreview.io`;

      loginOptions.uri = `${server}/llu/auth/login`;
      loginResp = await request(loginOptions);
    }

    if (!loginResp.data?.authTicket || !loginResp.data?.user) {
      return reply.code(401).send({
        success: false,
        code: 401,
        message: "Invalid login response",
        step: "auth",
      });
    }

    token = loginResp.data.authTicket.token;
    const userId = loginResp.data.user.id;
    accountId = crypto.createHash("sha256").update(userId).digest("hex");

    const connResp = await request({
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

    const graphResp = await request({
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
    const dir = getTrendDesc(meas.TrendArrow);
    const nowTs = epochTimeD(new Date());
    const graph = graphResp.data?.graphData || [];

    const hist = [];
    let delta;

    for (let j = 0; j < graph.length; j++) {
      const g = graph[j];
      const ts = epochTimeD(new Date(g.FactoryTimestamp));

      if (!noHist && nowTs - ts < 7500) {
        hist.push([ts, g.ValueInMgPerDl]);
      }

      if (ts === sgvTs && j > 0) {
        delta = g.ValueInMgPerDl - graph[j - 1].ValueInMgPerDl;
      }
    }

    return reply.code(200).send({
      success: true,
      sgvTs,
      sgv: meas.ValueInMgPerDl,
      dir,
      delta,
      ...(noHist ? {} : { hist }),
    });
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    const retryAfter = err?.response?.headers?.["retry-after"];

    return reply.code(statusCode).send({
      success: false,
      code: statusCode,
      message: err.message || "Unexpected error",
      step: "exception",
      ...(retryAfter ? { retryAfter } : {}),
    });
  }
});
/* Read from Libre LinkUp for 2 people
  Added graph historical data
  Version with redirect handling
  request parameters: id1, id2:  email
                      p1, p2: password
                      srv: server
  Reference: https://gist.github.com/khskekec/6c13ba01b10d3018d816706a32ae8ab2
*/
fastify.get("/bgllu2", async function (req, reply) {
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

  const input = [
    { email: req.query.id1, password: req.query.p1 },
    { email: req.query.id2, password: req.query.p2 },
  ];
  const srv = req.query.srv;

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
      input.map(({ email, password }) =>
        fetchLluUserData(email, password, srv, agent, product, version)
      )
    );

    results.forEach((res, idx) => {
      if (
        res.status === "fulfilled" &&
        res.value?.connectionData?.glucoseMeasurement
      ) {
        const { glucoseMeasurement, graphData } = res.value.connectionData;
        dir[idx] = getTrendDesc(glucoseMeasurement.TrendArrow);
        sgvTs[idx] = epochTimeD(new Date(glucoseMeasurement.FactoryTimestamp));
        sgv[idx] = glucoseMeasurement.ValueInMgPerDl;
        hist[idx] = [];

        const nowTs = epochTimeD(new Date());
        graphData?.forEach((entry, j) => {
          const ts = epochTimeD(new Date(entry.FactoryTimestamp));
          if (nowTs - ts < 7500) hist[idx].push([ts, entry.ValueInMgPerDl]);
          if (ts === sgvTs[idx] && j > 0) {
            delta[idx] = entry.ValueInMgPerDl - graphData[j - 1].ValueInMgPerDl;
          }
        });
      } else {
        if (!firstError) {
          const e = res.reason;
          firstError = {
            code: e?.statusCode || 500,
            message: e?.message || "Unexpected error",
            step: e?.step || "exception",
          };
        }
      }
    });

    if (firstError) {
      return reply.code(firstError.code).send({
        code: firstError.code,
        message: firstError.message,
        step: firstError.step,
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
    const code = err?.statusCode || 500;
    return reply.code(code).send({
      code,
      message: err.message || "Fatal exception",
      step: "fatal",
    });
  }
});

function getLluServer(srv) {
  var server = "https://api.libreview.io";
  if (srv != null) {
    switch (Number(srv)) {
      case 0: // US
        server = "https://api.libreview.io";
        break;
      case 1: // EU
        server = "https://api-eu.libreview.io";
        break;
      case 2: // DE Germany
        server = "https://api-de.libreview.io";
        break;
      case 3: // AP (Singapore)
        server = "https://api-ap.libreview.io";
        break;
      case 4: // (Brazil, Mexico, ??)
        server = "https://api-la.libreview.io";
        break;
      case 5: // RUssia
        server = "https://api.libreview.ru";
        break;
    }
  }
  return server;
}

async function fetchLluUserData(email, password, server) {
  const agent = "PostmanRuntime/7.43.0";
  const product = "llu.android";
  const version = "4.12.0";
  let accountId, token;

  let options = {
    method: "POST",
    uri: server + "/llu/auth/login",
    headers: {
      product,
      version,
      "Content-Type": "application/json",
      accept: "*/*",
      "User-Agent": agent,
    },
    body: { email, password },
    json: true,
  };

  let parsedBody = await request2(options);

  if (parsedBody.data.redirect) {
    const region = parsedBody.data.region;
    server =
      region === "ru"
        ? "https://api.libreview.ru"
        : `https://api-${region}.libreview.io`;
    options.uri = server + "/llu/auth/login";
    parsedBody = await request2(options);
  }

  token = parsedBody.data.authTicket.token;
  const userId = parsedBody.data.user.id;
  accountId = crypto.createHash("sha256").update(userId).digest("hex");

  const patientList = await request2({
    method: "GET",
    uri: server + "/llu/connections",
    headers: {
      product,
      version,
      "Account-Id": accountId,
      Authorization: "Bearer " + token,
      accept: "*/*",
      "User-Agent": agent,
      "cache-control": "no-cache",
    },
    json: true,
  });

  const patientId = patientList.data[0].patientId;

  const graphData = await request2({
    method: "GET",
    uri: `${server}/llu/connections/${patientId}/graph`,
    headers: {
      product,
      version,
      "Account-Id": accountId,
      Authorization: "Bearer " + token,
      accept: "*/*",
      "User-Agent": agent,
      "cache-control": "no-cache",
    },
    json: true,
  });

  const meas = graphData.data.connection.glucoseMeasurement;
  const nowTs = epochTimeD(new Date());
  const sgvTs = epochTimeD(new Date(meas.FactoryTimestamp));
  const sgv = meas.ValueInMgPerDl;
  const dir = getTrendDesc(meas.TrendArrow);

  const hist = [];
  let delta = null;
  if (graphData.data.graphData.length > 0) {
    for (let j = 0; j < graphData.data.graphData.length; j++) {
      const ts = epochTimeD(
        new Date(graphData.data.graphData[j].FactoryTimestamp)
      );
      if (nowTs - ts < 7500) {
        hist.push([ts, graphData.data.graphData[j].ValueInMgPerDl]);
      }
      if (ts === sgvTs && j > 0) {
        delta =
          graphData.data.graphData[j].ValueInMgPerDl -
          graphData.data.graphData[j - 1].ValueInMgPerDl;
      }
    }
  }

  return {
    sgvTs,
    sgv,
    dir,
    delta,
    iobTs: null,
    iob: null,
    cobTs: null,
    cob: null,
    upbat: 0,
    hist,
    avg: null,
    tir: [0, 0, 0],
  };
}

function getTrendDesc(trendArrow) {
  var dir = "NotDetermined";
  switch (Number(trendArrow)) {
    case 1:
      dir = "SingleDown";
      break;
    case 2:
      dir = "FortyFiveDown";
      break;
    case 3:
      dir = "Flat";
      break;
    case 4:
      dir = "FortyFiveUp";
      break;
    case 5:
      dir = "SingleUp";
      break;
  }
  return dir;
}

// ============================TESTING ===============================

fastify.get("/bgllutest", function (req, reply) {
  const agent = "PostmanRuntime/7.43.0";
  const product = "llu.android";
  const version = "4.12.0";
  // select server
  var server = "https://api.libreview.io";
  if (req.query.srv != null) {
    switch (Number(req.query.srv)) {
      case 0: // US
        server = "https://api.libreview.io";
        break;
      case 1: // EU
        server = "https://api-eu.libreview.io";
        break;
      case 2: // DE Germany
        server = "https://api-de.libreview.io";
        break;
      case 3: // AP (Singapore)
        server = "https://api-ap.libreview.io";
        break;
      case 4: // (Brazil, Mexico, ??)
        server = "https://api-la.libreview.io";
        break;
      case 5: // RUssia
        server = "https://api.libreview.ru";
        break;
    }
  }
  var resp = { success: false };
  var accountId;
  var token;
  var options = {
    method: "POST",
    uri: server + "/llu/auth/login",
    headers: {
      product: product,
      version: version,
      "Content-Type": "application/json",
      accept: "*/*",
      "User-Agent": agent,
      //'Postman-Token': '5b0f574b-f03d-48bc-af63-0a6f0d04ae0f'
    },
    body: {
      email: req.query.id,
      password: req.query.p,
    },
    json: true, // Automatically stringifies the body to JSON
  };
  resp = { success: false, step: 0 };
  request(options, function (error, response, body) {
    resp = { success: false, step: 1, code: response.statusCode, r: response };
    //let info = JSON.parse(body);
    console.log(response.statusCode);
    //console.log(body);
    // 476 status code may mean too many requests have been sent in a short period of time
    if (response.statusCode == 200) {
      resp = {
        success: true,
        step: 1,
        userid: body.data.user.id,
        firstName: body.data.user.firstName,
        lastName: body.data.user.lastName,
        token: body.data.authTicket.token,
      };
      console.log(body.data.user.id);
      console.log(body.data.user.firstName);
      console.log(body.data.user.lastName);
      console.log(body.data.authTicket.token);
    }
    reply.code(200).send(resp);
  });
  //reply.code(200).send(resp);
});

// ======================================================================
// Run the server and report out to the logs
fastify.listen(
  { port: process.env.PORT, host: "0.0.0.0" },
  function (err, address) {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Your app is listening on ${address}`);
  }
);
