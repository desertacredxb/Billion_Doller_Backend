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
      // console.log("MT5 GET RAW RESPONSE:", {
      //   path: path,
      //   statusCode: res.statusCode,
      //   headers: res.headers,
      //   body: respBody,
      // });
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
      // console.log("MT5 POST RAW RESPONSE:", {
      //   path: path,
      //   statusCode: res.statusCode,
      //   headers: res.headers,
      //   body: respBody,
      // });
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
      // console.log("MT5 POST(JSON) RAW RESPONSE:", {
      //   // req: req,
      //   path: path,
      //   statusCode: res.statusCode,
      //   headers: res.headers,
      //   body: respBody,
      //   data: JSON.stringify(jsonBody),
      // });
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

  // Percent-encode manually (same approach as TradeBalance below) instead of
  // URLSearchParams, which encodes spaces as "+" per the
  // application/x-www-form-urlencoded convention - that's only correctly
  // decoded back to a space by parsers that treat it as a form BODY. MT5's
  // query-string parser doesn't: "Prince Gopal" was arriving as the literal
  // string "Prince+Gopal", and since MT5 splits Name into
  // FirstName/LastName/MiddleName on whitespace, finding no actual space it
  // dumped the whole string into FirstName and left LastName/MiddleName empty.
  var queryParams = [
    "group=" + encodeURIComponent(params.group),
    "name=" + encodeURIComponent(params.name),
    "leverage=" + encodeURIComponent(params.leverage),
  ];
  if (params.login) queryParams.push("login=" + encodeURIComponent(params.login));
  if (params.country) queryParams.push("country=" + encodeURIComponent(params.country));
  if (params.phone) queryParams.push("phone=" + encodeURIComponent(params.phone));
  if (params.email) queryParams.push("email=" + encodeURIComponent(params.email));

  var qs = queryParams.join("&");

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


// MT5Request.prototype.TradeBalance = function (params, callback) {
//   var self = this;

//   if (!params || !params.login || params.balance === undefined) {
//     return callback && callback("Missing required parameters (login, balance)");
//   }

//   // Structure payload matching MT5 WebAPI JSON expectations
//   var jsonBody = {
//     Login: Number(params.login),
//     Type: Number(params.type ?? 2), // 2 = Balance operation
//     Balance: Number(params.balance),
//     Comment: String(params.comment ?? "Deposit/Withdrawal").substring(0, 31), // Max 32 chars
//   };

//   if (params.check_margin !== undefined) {
//     jsonBody.CheckMargin = Number(params.check_margin);
//   }

//   self.PostJSON("/api/trade/balance", jsonBody, function (error, res, body) {
//     var answer = self.ParseBodyJSON(error, res, body, callback);
//     if (answer) {
//       return callback && callback(null, answer);
//     }
//   });
// };

MT5Request.prototype.TradeBalance = function (params, callback) {
  var self = this;

  // 1. Validate required parameters according to MT5 protocol
  if (!params || params.login === undefined || params.balance === undefined) {
    return callback && callback("Missing required parameters: 'login' and 'balance' are required.");
  }

  var login = params.login;
  var type = params.type !== undefined ? params.type : 2; // Default 2 (DEAL_BALANCE)
  var balance = params.balance;
  var comment = params.comment !== undefined ? String(params.comment).substring(0, 31) : "Deposit";
  var checkMargin = params.check_margin ? "1" : "0";

  // 2. Format query string using percent-encoding matching MT5 Web API spec
  var queryParams = [
    "login=" + encodeURIComponent(login),
    "type=" + encodeURIComponent(type),
    "balance=" + encodeURIComponent(balance),
    "comment=" + encodeURIComponent(comment),
    "check_margin=" + encodeURIComponent(checkMargin)
  ];

  var path = "/api/trade/balance?" + queryParams.join("&");

  // 3. MTTradeProtocol sends requests via GET
  self.Get(path, function (error, res, body) {
    if (error) {
      return callback && callback(error);
    }

    var answer = self.ParseBodyJSON(error, res, body, callback);
    if (!answer) return;

    // 4. Match MTTradeAnswer parsing logic from PHP SDK
    // MT5 returns "0 Done" or "0" in retcode on success
    var retCode = answer.retcode ? answer.retcode.toString() : "";
    
    if (retCode.startsWith("0") || retCode === "0 Done") {
      return callback && callback(null, {
        retcode: answer.retcode,
        ticket: answer.ticket ? parseInt(answer.ticket, 10) : 0,
        raw: answer
      });
    } else {
      return callback && callback("MT5 Server Error [" + answer.retcode + "]");
    }
  });
};

MT5Request.prototype.UserGet = function (login, callback) {
  var self = this;

  if (!login) {
    return callback && callback("login is required");
  }

  // Kept consistent with UserAdd's manual percent-encoding above, even though
  // a numeric login never actually needs it.
  var qs = "login=" + encodeURIComponent(String(login));

  self.Get("/api/user/get?" + qs, function (error, res, body) {
    var answer = self.ParseBodyJSON(error, res, body, callback);

    if (answer) {
      callback && callback(null, answer);
    }
  });
};

// --- Referral-system MT5 services (deal history + live account state) ---
// Added to support the IB commission calculation, but NOT wired into
// commissionService.js / ibController.js yet - path names here follow the
// same convention as the calls above (UserGet -> /api/user/get, TradeBalance
// -> /api/trade/balance) but are NOT yet confirmed against the live facade.
// Verify with scripts/testMT5DealServices.js against a known login before
// relying on these for real commission numbers.

MT5Request.prototype.AccountGet = function (login, callback) {
  var self = this;

  if (!login) {
    return callback && callback("login is required");
  }

  var qs = "login=" + encodeURIComponent(String(login));

  self.Get("/api/user/account/get?" + qs, function (error, res, body) {
    var answer = self.ParseBodyJSON(error, res, body, callback);
    if (answer) {
      callback && callback(null, answer);
    }
  });
};

MT5Request.prototype.DealGetTotal = function (params, callback) {
  var self = this;

  if (!params || !params.login || params.from === undefined || params.to === undefined) {
    return callback && callback("Missing required parameters: 'login', 'from' and 'to' are required.");
  }

  var queryParams = [
    "login=" + encodeURIComponent(String(params.login)),
    "from=" + encodeURIComponent(params.from),
    "to=" + encodeURIComponent(params.to),
  ];

  self.Get("/api/deal/get_total?" + queryParams.join("&"), function (error, res, body) {
    var answer = self.ParseBodyJSON(error, res, body, callback);
    if (answer) {
      callback && callback(null, answer);
    }
  });
};

MT5Request.prototype.DealGetPage = function (params, callback) {
  var self = this;

  if (!params || !params.login || params.from === undefined || params.to === undefined) {
    return callback && callback("Missing required parameters: 'login', 'from' and 'to' are required.");
  }

  var login = params.login;
  var from = params.from;
  var to = params.to;
  var offset = params.offset !== undefined ? params.offset : 0;
  var total = params.total !== undefined ? params.total : 1000;

  var queryParams = [
    "login=" + encodeURIComponent(String(login)),
    "from=" + encodeURIComponent(from),
    "to=" + encodeURIComponent(to),
    "offset=" + encodeURIComponent(offset),
    "total=" + encodeURIComponent(total),
  ];

  self.Get("/api/deal/get_page?" + queryParams.join("&"), function (error, res, body) {
    var answer = self.ParseBodyJSON(error, res, body, callback);
    if (answer) {
      callback && callback(null, answer);
    }
  });
};

MT5Request.prototype.UserPasswordChange = function (params, callback) {
  var self = this;

  if (!params.login || !params.type || !params.password) {
    return callback && callback("Missing required parameters (login, type, password)");
  }

  var jsonBody = {
    Login: String(params.login),
    Type: String(params.type).toLowerCase(), // "main", "investor", or "api"
    Password: String(params.password),
  };

  self.PostJSON("/api/user/change_password", jsonBody, function (error, res, body) {
    var answer = self.ParseBodyJSON(error, res, body, callback);
    if (answer) callback && callback(null, answer);
  });
};

module.exports = MT5Request;