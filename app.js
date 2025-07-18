/**
 * This is the main server script that provides the API endpoints
 *
 */

const fastify = require("fastify")({
  // Set this to true for detailed logging:
  logger: false,
});

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

// read from Dexcom Share
fastify.get("/bgdex", function (request, reply) {
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
  var iob = null;
  var iobTs = null;
  var cob = null;
  var cobTs = null;
  var upbat = 0;
  var hist = null;
  var avg = null;
  var tir = [0, 0, 0];
  client
    .getEstimatedGlucoseValues({ maxCount: 288, minutes: 1440 })
    .then((data) => {
      //console.log(data.length);
      //console.log(data);
      if (data[0] != null) {
        sgv = data[0].mgdl;
        dir = data[0].trend;
        sgvTs = Math.floor(data[0].timestamp / 1000);
        if (data[1] != null) {
          const prevSgv = data[0].mgdl;
          // if time diff is reasonable 10 minutes or less
          if (data[0].timestamp - data[1].timestamp <= 10 * 60 * 1000) {
            delta = data[0].mgdl - data[1].mgdl;
          }
        }
        var h = []; // 2 hour history
        let endIdx = data.length > 24 ? 23 : data.length - 1;
        for (var k = endIdx; k >= 0; k--) {
          let elem = [Math.floor(data[k].timestamp / 1000), data[k].mgdl];
          h.push(elem);
        }
        hist = h;
      }
      // calc time in ranges (3 ranges)
      var accum = 0;
      var cnt = 0;
      const oneDayPrior = (epochTime() - 24 * 3600) * 1000;
      for (var k = data.length - 1; k >= 0; k--) {
        if (data[k].timestamp >= oneDayPrior) {
          accum += data[k].mgdl;
          cnt++;
          if (
            data[k].mgdl <= request.query.tu &&
            data[k].mgdl >= request.query.tl
          ) {
            tir[0] += 5;
          } else if (
            data[k].mgdl <= request.query.du &&
            data[k].mgdl >= request.query.dl
          ) {
            tir[1] += 5;
          } else {
            tir[2] += 5;
          }
        }
      }
      avg = Math.round(accum / cnt);

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
fastify.get("/bgdex2", (request, reply) => {
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

  const client1 = new dexcom.DexcomClient({
    username: request.query.id1,
    password: request.query.p1,
    // This server needs to be either "us" or "eu. If you're in the US, the server
    // should be "us". Any other country outside of the US (eg. Canada) is
    // classified as "eu" by Dexcom
    server: request.query.srv,
  });
  const client2 = new dexcom.DexcomClient({
    username: request.query.id2,
    password: request.query.p2,
    server: request.query.srv,
  });

  var promises = [];
  promises.push(
    client1.getEstimatedGlucoseValues({ maxCount: 288, minutes: 1440 })
  );
  promises.push(
    client2.getEstimatedGlucoseValues({ maxCount: 288, minutes: 1440 })
  );
  Promise.all(promises)
    .then((data) => {
      // data = [promise1,promise2]
      for (var i = 0; i < 2; i++) {
        // for each person
        if (data[i] != null) {
          sgv[i] = data[i][0].mgdl;
          dir[i] = data[i][0].trend;
          sgvTs[i] = Math.floor(data[i][0].timestamp / 1000);
          if (data[i][1] != null) {
            const prevSgv = data[i][0].mgdl;
            // if time diff is reasonable 10 minutes or less
            if (data[i][0].timestamp - data[i][1].timestamp <= 10 * 60 * 1000) {
              delta[i] = data[i][0].mgdl - data[i][1].mgdl;
            }
          }
          var h = []; // 2 hour history
          let endIdx = data[i].length > 24 ? 23 : data[i].length - 1;
          for (var k = endIdx; k >= 0; k--) {
            let elem = [
              Math.floor(data[i][k].timestamp / 1000),
              data[i][k].mgdl,
            ];
            h.push(elem);
          }
          hist[i] = h;
        }
        // calc time in ranges (3 ranges)
        var accum = 0;
        var cnt = 0;
        const oneDayPrior = (epochTime() - 24 * 3600) * 1000;
        for (var k = data[i].length - 1; k >= 0; k--) {
          if (data[i][k].timestamp >= oneDayPrior) {
            accum += data[i][k].mgdl;
            cnt++;
            if (
              data[i][k].mgdl <= request.query.tu &&
              data[i][k].mgdl >= request.query.tl
            ) {
              tir[i][0] += 5;
            } else if (
              data[i][k].mgdl <= request.query.du &&
              data[i][k].mgdl >= request.query.dl
            ) {
              tir[i][1] += 5;
            } else {
              tir[i][2] += 5;
            }
          }
        }
        avg[i] = Math.round(accum / cnt);
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

function handleLluError(reply, parsedBody, step) {
  const httpCode = [401, 403, 429, 476].includes(parsedBody.status)
    ? parsedBody.status
    : 400;

  reply.code(httpCode).send({
    success: false,
    error: parsedBody.error?.message || "Login failed or rate limited",
    step,
    raw: parsedBody,
  });

  throw new Error("Abort chain");
}

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

    const response = {
      success: true,
      sgvTs,
      sgv: meas.ValueInMgPerDl,
      dir,
      delta,
    };

    if (!noHist) response.hist = hist;

    return reply.code(200).send(response);
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
fastify.get("/bgllu2", function (req, reply) {
  var sgvTs = [null, null];
  var sgv = [null, null];
  var dir = [null, null];
  var delta = [null, null];
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

  const agent = "PostmanRuntime/7.43.0";
  const product = "llu.android";
  const version = "4.12.0";
  // select server
  var server = getLluServer(req.query.srv);
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
    },
    body: {
      email: req.query.id1,
      password: req.query.p1,
    },
    json: true, // Automatically stringifies the body to JSON
  };
  resp = { success: false, step: 0 };
  request2(options)
    .then(function (parsedBody) {
      resp = { success: false, step: 1 };
      // determine if we have the right server
      /*
          if credentials are correct but server is wrong, 
          response will be like:
          {"status":0,"data":{"redirect":true,"region":"eu"}}
        */
      if (parsedBody.data.redirect != null) {
        // get region and build correct server uri
        let region = parsedBody.data.region;
        if (region == "ru") {
          server = "https://api.libreview.ru";
        } else {
          server = "https://api-" + region + ".libreview.io";
        }
        options.uri = server + "/llu/auth/login";
        // repeat request on correct server
        return request2(options);
      } else {
        // continue to next step
        return parsedBody;
      }
    })
    .then(function (parsedBody) {
      resp = { success: false, step: 2 };
      let userId = parsedBody.data.user.id;
      token = parsedBody.data.authTicket.token;
      accountId = crypto
        .createHash("sha256")
        .update(parsedBody.data.user.id)
        .digest("hex");
      let options2 = {
        method: "GET",
        uri: server + "/llu/connections",
        headers: {
          product: product,
          version: version,
          "Account-Id": accountId,
          Authorization: "Bearer " + token,
          accept: "*/*",
          "User-Agent": agent,
          "cache-control": "no-cache",
        },
        json: true, // Automatically stringifies the body to JSON
      };
      return request2(options2);
    })
    .then(function (parsedBody) {
      resp = { success: false, step: 3 };
      const patientId = parsedBody.data[0].patientId;
      let options3 = {
        method: "GET",
        uri: server + "/llu/connections/" + patientId + "/graph",
        headers: {
          product: product,
          version: version,
          "Account-Id": accountId,
          Authorization: "Bearer " + token,
          accept: "*/*",
          "User-Agent": agent,
          "cache-control": "no-cache",
        },
        json: true, // Automatically stringifies the body to JSON
      };
      return request2(options3);
    })
    .then(function (parsedBody) {
      resp = { success: false, step: 4 };
      let meas = parsedBody.data.connection.glucoseMeasurement;
      // convert trendArrow into standard strings
      dir[0] = getTrendDesc(meas.TrendArrow);
      // convert FactoryTimestamp (UTC) to an epoch time value
      sgvTs[0] = epochTimeD(new Date(meas.FactoryTimestamp));
      sgv[0] = meas.ValueInMgPerDl;
      hist[0] = [];
      var nowTs = epochTimeD(new Date());
      if (parsedBody.data.graphData.length > 0) {
        // order of data appears to be oldest first
        for (var j = 0; j < parsedBody.data.graphData.length; j++) {
          // limit to data 2 hours old
          var ts = epochTimeD(
            new Date(parsedBody.data.graphData[j].FactoryTimestamp)
          );
          if (nowTs - ts < 7500) {
            // 2h+5min margin
            let elem = [ts, parsedBody.data.graphData[j].ValueInMgPerDl];
            hist[0].push(elem);
          }
          if (ts == sgvTs[0] && j > 0) {
            // if latest value
            // calculate delta from previous value
            delta[0] =
              parsedBody.data.graphData[j].ValueInMgPerDl -
              parsedBody.data.graphData[j - 1].ValueInMgPerDl;
          }
        }
      }
      // START REQUEST FOR PERSON 2 =====================================================
      server == getLluServer(req.query.srv);
      options = {
        method: "POST",
        uri: server + "/llu/auth/login",
        headers: {
          product: product,
          version: version,
          "Content-Type": "application/json",
          accept: "*/*",
          "User-Agent": agent,
        },
        body: {
          email: req.query.id2,
          password: req.query.p2,
        },
        json: true, // Automatically stringifies the body to JSON
      };
      return request2(options);
    })
    .then(function (parsedBody) {
      resp = { success: false, step: 5 };
      // determine if we have the right server
      /*
          if credentials are correct but server is wrong, 
          response will be like:
          {"status":0,"data":{"redirect":true,"region":"eu"}}
        */
      if (parsedBody.data.redirect != null) {
        // get region and build correct server uri
        let region = parsedBody.data.region;
        if (region == "ru") {
          server = "https://api.libreview.ru";
        } else {
          server = "https://api-" + region + ".libreview.io";
        }
        options.uri = server + "/llu/auth/login";
        // repeat request on correct server
        return request2(options);
      } else {
        // continue to next step
        return parsedBody;
      }
    })
    .then(function (parsedBody) {
      resp = { success: false, step: 6 };
      let userId = parsedBody.data.user.id;
      token = parsedBody.data.authTicket.token;
      accountId = crypto
        .createHash("sha256")
        .update(parsedBody.data.user.id)
        .digest("hex");
      let options2 = {
        method: "GET",
        uri: server + "/llu/connections",
        headers: {
          product: product,
          version: version,
          "Account-Id": accountId,
          Authorization: "Bearer " + token,
          accept: "*/*",
          "User-Agent": agent,
          "cache-control": "no-cache",
        },
        json: true, // Automatically stringifies the body to JSON
      };
      return request2(options2);
    })
    .then(function (parsedBody) {
      resp = { success: false, step: 7 };
      const patientId = parsedBody.data[0].patientId;
      let options3 = {
        method: "GET",
        uri: server + "/llu/connections/" + patientId + "/graph",
        headers: {
          product: product,
          version: version,
          "Account-Id": accountId,
          Authorization: "Bearer " + token,
          accept: "*/*",
          "User-Agent": agent,
          "cache-control": "no-cache",
        },
        json: true, // Automatically stringifies the body to JSON
      };
      return request2(options3);
    })
    .then(function (parsedBody) {
      resp = { success: false, step: 8 };
      let meas = parsedBody.data.connection.glucoseMeasurement;
      // convert trendArrow into standard strings
      dir[1] = getTrendDesc(meas.TrendArrow);
      // convert FactoryTimestamp (UTC) to an epoch time value
      sgvTs[1] = epochTimeD(new Date(meas.FactoryTimestamp));
      sgv[1] = meas.ValueInMgPerDl;
      hist[1] = [];
      var nowTs = epochTimeD(new Date());
      if (parsedBody.data.graphData.length > 0) {
        // order of data appears to be oldest first
        for (var j = 0; j < parsedBody.data.graphData.length; j++) {
          // limit to data 2 hours old
          var ts = epochTimeD(
            new Date(parsedBody.data.graphData[j].FactoryTimestamp)
          );
          if (nowTs - ts < 7500) {
            // 2h+5min margin
            let elem = [ts, parsedBody.data.graphData[j].ValueInMgPerDl];
            hist[1].push(elem);
          }
          if (ts == sgvTs[1] && j > 0) {
            // if latest value
            // calculate delta from previous value
            delta[1] =
              parsedBody.data.graphData[j].ValueInMgPerDl -
              parsedBody.data.graphData[j - 1].ValueInMgPerDl;
          }
        }
      }
      resp = {
        sgvTs: sgvTs,
        //ts: meas.FactoryTimestamp,
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
    })
    .finally(function () {
      reply.code(200).send(resp);
    })
    .catch(function (err) {
      // POST failed...
      // NOTE: if error 430, then too many requests are being made within a short time period.
      // this is a server attack protection
      console.log("ERROR!");
      //console.log(err.statusCode);
      console.log(err);
      reply.code(err.statusCode).send({ result: 0 });
    });
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
