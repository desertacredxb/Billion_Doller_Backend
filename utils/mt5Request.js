const https = require("https");
const crypto = require('crypto');
const buffer = require('buffer');

function MT5Request(server, port) {
  this.server = server;
  this.port = port;
  this.https = new https.Agent({
    keepAlive: true,   // <-- this is the fix
    maxSockets: 1,
  });
  // this.https.maxSockets = 1; // only one connection is used 

  this.https.on('free', () => console.log("SOCKET FREED (returned to pool)"));


  var originalCreateConnection = this.https.createConnection;
  var count = 0;
  this.https.createConnection = function (...args) {
    count++;
    console.log("NEW SOCKET CREATED, total so far:", count);
    return originalCreateConnection.apply(this, args);
  };
}

MT5Request.prototype.Get = function (path, callback) {
  var options = {
    hostname: this.server,
    port: this.port,
    path: path,
    agent: this.https,
    headers: { "Connection": "keep-alive" },
    rejectUnauthorized: false,
  };
  var req = https.get(options, function (res) {
    res.setEncoding('utf8');
    var respBody = "";
    res.on('data', function (chunk) { respBody += chunk; });
    res.on('end', function () {
      console.log("MT5 GET RAW RESPONSE:", {
        path: path,
        statusCode: res.statusCode,
        headers: res.headers,
        body: respBody,
      });
      callback(null, res, respBody);
    });
  });
  req.on('error', function (e) {
    console.log(e);
    return callback(e);
  });
};

MT5Request.prototype.Post = function (path, body, callback) {
  var options = {
    hostname: this.server,
    port: this.port,
    path: path,
    agent: this.https,
    method: "POST",
    headers: {
      "Connection": "keep-alive",
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
    rejectUnauthorized: false, // comment out this line if you use self-signed certificates 
  };
  var req = https.request(options, function (res) {
    res.setEncoding('utf8');
    var respBody = "";
    res.on('data', function (chunk) { respBody += chunk; });
    res.on('end', function () {
      console.log("MT5 POST RAW RESPONSE:", {
        path: path,
        statusCode: res.statusCode,
        headers: res.headers,
        body: respBody,
      });
      callback(null, res, respBody);
    });
  });
  req.on('error', function (e) {
    console.log(e);
    return callback(e);
  });
  req.write(body);
  req.end();
};


MT5Request.prototype.ParseBodyJSON = function (error, res, body, callback) {
  if (error) {
    callback && callback(error);
    return (null);
  }
  if (res.statusCode != 200) {
    callback && callback(res.statusCode);
    return (null);
  }
  var answer = null;
  try {
    answer = JSON.parse(body);
  }
  catch {
    console.log("Parse JSON error");
  }
  if (!answer) {
    callback && callback("invalid body answer");
    return (null);
  }
  var retcode = parseInt(answer.retcode);
  if (retcode != 0) {
    callback && callback(answer.retcode);
    return (null);
  }
  return (answer);
}

MT5Request.prototype.ProcessAuth = function (answer, password) {
  //--- 
  var pass_md5 = crypto.createHash('md5');
  var buf = buffer.transcode(Buffer.from(password, 'utf8'), 'utf8', 'utf16le');
  pass_md5.update(buf, 'binary');
  var pass_md5_digest = pass_md5.digest('binary');
  //--- 
  var md5 = crypto.createHash('md5');
  md5.update(pass_md5_digest, 'binary');
  md5.update('WebAPI', 'ascii');
  var md5_digest = md5.digest('binary');
  //--- 
  var answer_md5 = crypto.createHash('md5');
  answer_md5.update(md5_digest, 'binary');
  var buf = Buffer.from(answer.srv_rand, 'hex');
  answer_md5.update(buf, 'binary');
  //--- 
  return (answer_md5.digest('hex'));
}

MT5Request.prototype.ProcessAuthFinal = function (answer, password, cli_random) {
  //--- 
  var pass_md5 = crypto.createHash('md5');
  var buf = buffer.transcode(Buffer.from(password, 'utf8'), 'utf8', 'utf16le');
  pass_md5.update(buf, 'binary');
  var pass_md5_digest = pass_md5.digest('binary');
  //--- 
  var md5 = crypto.createHash('md5');
  md5.update(pass_md5_digest, 'binary');
  md5.update('WebAPI', 'ascii');
  var md5_digest = md5.digest('binary');
  //--- 
  var answer_md5 = crypto.createHash('md5');
  answer_md5.update(md5_digest, 'binary');
  answer_md5.update(cli_random, 'binary');
  return (answer.cli_rand_answer == answer_md5.digest('hex'));
}

MT5Request.prototype.Auth = function (login, password, build, agent, callback) {
  if (!login || !password || !build || !agent)
  {
        return callback && callback("Missing required Auth parameters (login/password/build/agent)");
  }
  var self = this;
  self.Get("/api/auth/start?version=" + build + "&agent=" + agent + "&login=" + login + "&type=manager", function (error, res, body) {
    var answer = self.ParseBodyJSON(error, res, body, callback);
    if (answer) {
      var srv_rand_answer = self.ProcessAuth(answer, password);
      var cli_random_buf = crypto.randomBytes(16);
      cli_random_buf_hex = cli_random_buf.toString('hex');
      self.Get("/api/auth/answer?srv_rand_answer=" + srv_rand_answer + "&cli_rand=" + cli_random_buf_hex, function (error, res, body) {
        var answer = self.ParseBodyJSON(error, res, body, callback);
        if (answer) {
          if (self.ProcessAuthFinal(answer, password, cli_random_buf))
            callback && callback(null);
          else
            callback && callback("invalid final auth answer");
        }

      });
    }
  });
  return (true);
};


// MT5Request.prototype.UserAdd = function (params, callback) {
//   var self = this;
//   var qs = new URLSearchParams(params).toString();
//   self.Get("/api/user/add?" + qs, function (error, res, body) {
//     var answer = self.ParseBodyJSON(error, res, body, callback);
//     if (answer) callback && callback(null, answer);
//   });
// };

// MT5Request.prototype.UserAdd = function (params, callback) {
//   console.log("checkpoint mt5 1");

//   var self = this;
//   var body = new URLSearchParams(params).toString();
//   self.Post("/api/user/add", body, function (error, res, body) {   // capital P
//     var answer = self.ParseBodyJSON(error, res, body, callback);
//     if (answer) callback && callback(null, answer);
//   });

//   console.log("checkpoint mt5 2");

// };


MT5Request.prototype.PostJSON = function (path, jsonBody, callback) {
  var bodyStr = JSON.stringify(jsonBody);
  var options = {
    hostname: this.server,
    port: this.port,
    path: path,
    agent: this.https,
    method: "POST",
    headers: {
      "Connection": "keep-alive",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(bodyStr),
    },
    rejectUnauthorized: false,
  };
  var req = https.request(options, function (res) {
    res.setEncoding('utf8');
    var respBody = "";
    res.on('data', function (chunk) { respBody += chunk; });
    res.on('end', function () {
      console.log("MT5 POST(JSON) RAW RESPONSE:", {
        // req: req,
        path: path,
        statusCode: res.statusCode,
        headers: res.headers,
        body: respBody,
        data: JSON.stringify(jsonBody),
      });
      callback(null, res, respBody);
    });
  });
  req.on('error', function (e) {
    console.log(e);
    return callback(e);
  });
  req.write(bodyStr);
  req.end();
};

MT5Request.prototype.UserAdd = function (params, callback) {
  var self = this;

  var queryParams = {
    group: params.group,
    name: params.name,
    leverage: params.leverage,
  };
  if (params.login) queryParams.login = params.login;
  if (params.country) queryParams.country = params.country;
  if (params.phone) queryParams.phone = params.phone;
  if (params.email) queryParams.email = params.email;

  var qs = new URLSearchParams(queryParams).toString();

  var jsonBody = {
    PassMain: params.pass_main,
    PassInvestor: params.pass_investor,
  };

  console.log("query", qs);

  self.PostJSON("/api/user/add?" + qs, jsonBody, function (error, res, body) {
    var answer = self.ParseBodyJSON(error, res, body, callback);
    if (answer) callback && callback(null, answer);
  });
};


MT5Request.prototype.TradeBalance = function (params, callback) {
  var self = this;
  var queryParams = {
    login: params.login,
    type: params.type,
    balance: params.balance,
    comment: params.comment,
  };
  var qs = new URLSearchParams(queryParams).toString();

  self.Post("/api/trade/balance?" + qs, "", function (error, res, body) {
    var answer = self.ParseBodyJSON(error, res, body, callback);
    if (answer) callback && callback(null, answer);
  });
};

module.exports = MT5Request;