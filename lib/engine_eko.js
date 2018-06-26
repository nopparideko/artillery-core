/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const async = require('async');
const _ = require('lodash');
const WebSocket = require('ws');
const debug = require('debug')('ws');
const engineUtil = require('./engine_util');
const template = engineUtil.template;
const request = require('request')
const path = require('path');
const configEnv = process.env.PWD + '/config.json'
const fs = require('fs')

module.exports = WSEngine;

function WSEngine(script) {
  this.config = replaceConfigWithEnv(script.config);
}

function replaceConfigWithEnv(config) {
  let selfConfig = config

  //Read from config file first
  if (fs.existsSync(configEnv)) {
    fs.readFile(configEnv, function(err, raw) {
      const data = JSON.parse(raw.toString())
      selfConfig.target = data.target
      selfConfig.targetToken = data.targetToken
      selfConfig.phases[0].duration = data.duration
      selfConfig.phases[0].arrivalCount = data.arrivalCount
      selfConfig.username = data.username
      selfConfig.password = data.password
      selfConfig.usertoken = data.token
    })
  }

  if (process.env.TARGET_URL) {
    selfConfig.target = process.env.TARGET_URL
  }

  if (process.env.TARGET_TOKEN_URL) {
    selfConfig.targetToken = process.env.TARGET_TOKEN_URL
  }

  if (process.env.PHASE_DURATION) {
    selfConfig.phases[0].duration = process.env.PHASE_DURATION
  }

  if (process.env.PHASE_ARRIVAL) {
    selfConfig.phases[0].arrivalCount = process.env.PHASE_ARRIVAL
  }

  if (process.env.TEST_USERNAME) {
    selfConfig.username = process.env.TEST_USERNAME
  }

  if (process.env.TEST_PASSWORD) {
    selfConfig.password = process.env.TEST_PASSWORD
  }

  if (process.env.USER_TOKEN) {
    selfConfig.usertoken = process.env.USER_TOKEN
  }

  return selfConfig
}

WSEngine.prototype.createScenario = function(scenarioSpec, ee) {
  var self = this;
  let tasks = _.map(scenarioSpec.flow, function(rs) {
    if (rs.think) {
      return engineUtil.createThink(rs, _.get(self.config, 'defaults.think', {}));
    }
    return self.step(rs, ee);
  });

  return self.compile(tasks, scenarioSpec.flow, ee);
};

WSEngine.prototype.step = function (requestSpec, ee) {
  let self = this;

  if (requestSpec.loop) {
    let steps = _.map(requestSpec.loop, function(rs) {
      return self.step(rs, ee);
    });

    return engineUtil.createLoopWithCount(
      requestSpec.count || -1,
      steps,
      {
        loopValue: requestSpec.loopValue || '$loopCount',
        overValues: requestSpec.over
      });
  }

  if (requestSpec.think) {
    return engineUtil.createThink(requestSpec, _.get(self.config, 'defaults.think', {}));
  }

  let paramsExtract = function(params, context) {
    let result = {}
    let key = Object.keys(params)
    for (var j = 0; j < key.length; j++) {
      if (context.vars[key[j]] != undefined) {
        result[key[j]] = context.vars[key[j]]
      }
    }
    return result
  }

  let paramsVariable = function(params, context) {
    let result = {}
    if (typeof(params) == 'object') {
      let keys = Object.keys(params)
      for (var i = 0; i < keys.length; i++) {
        result = paramsExtract(params[keys[i]], context)
      }
    } else if (typeof(params) == 'Array') {
      for (var i = 0; i < params.length; i++) {
        if (typeof(params[i]) == 'object') {
          result = paramsExtract(params[i], context)
        }
      }
    } else if (typeof(params) == 'string' && params.charAt(0) == '$') {
      result = context.vars[params.slice(1)]
    }
    if (_.isEmpty(result)) {
      result = template(params, context)
    } else {
      result = [result]
    }
    return result
  }

  let f = function(context, callback) {
    ee.emit('request');
    let startedAt = process.hrtime();

    if (requestSpec.function) {
      let processFunc = self.config.processor[requestSpec.function];
      if (processFunc) {
        processFunc(context, ee, function () {
          return callback(null, context);
        });
      }
    }

    // if (process.env.TARGET_URL) {
    //   script.config.target = process.env.TARGET_URL
    // }
    if (!(requestSpec.send && requestSpec.send.rpc && requestSpec.send.params)) {
      return ee.emit('error', 'invalid arguments');
    }

    let ekoPayload = {
      id: context._uid,
      m: template(requestSpec.send.rpc, context),
      // p: template(requestSpec.send.params, context)
      p: paramsVariable(requestSpec.send.params, context)
    };
    const ekoSendCode = 41;
    ekoPayload = `${ekoSendCode}|${JSON.stringify(ekoPayload)}`;
    debug('WS send: %s', ekoPayload);
    context.ws.on('message', function(msg) {
      // console.log('>', msg)
    });

    context.ws.send(ekoPayload, function(err) {
      if (err) {
        debug(err);
        ee.emit('error', err);
      } else {
        let endedAt = process.hrtime(startedAt);
        let delta = (endedAt[0] * 1e9) + endedAt[1];
        ee.emit('response', delta, 0, context._uid);
      }
      return callback(err, context);
    });
  };

  return f;
};

WSEngine.prototype.compile = function (tasks, scenarioSpec, ee) {
  let config = this.config;

  return function scenario(initialContext, callback) {
    async function zero(callback) {
      let tls = config.tls || {}; // TODO: config.tls is deprecated
      let options = _.extend(tls, config.ws);
      const { targetToken, username, password, usertoken } = config;
      // const token = await getEkoRPCToken(targetToken, { username, password });
      const ekoRpcVersion = config.version || 'v2';
      const rpcTarget = `${config.target}/${ekoRpcVersion}?token=${usertoken}`;
      ee.emit('started');
      // console.log('rpc:', config)
      if (config.ws == undefined) {
        let ws = new WebSocket(rpcTarget, options);
        ws.on('open', function() {
          initialContext.ws = ws;
          config.ws = ws
          return callback(null, initialContext);
        });
        ws.once('error', function(err) {
          debug(err);
          ee.emit('error', err.code);
          return callback(err, {});
        });
        console.log('RPC Connected')
      } else {
        initialContext.ws = config.ws
      }
    }

    initialContext._successCount = 0;
    initialContext._pendingRequests = _.size(
      _.reject(scenarioSpec, function(rs) {
        return (typeof rs.think === 'number');
      }));

    let steps = _.flatten([
      zero,
      tasks
    ]);

    async.waterfall(
      steps,
      function scenarioWaterfallCb(err, context) {
        if (err) {
          debug(err);
        }
        if (context && context.ws) {
          context.ws.close();
        }

        return callback(err, context);
      });
  };
};

function getEkoRPCToken(target, user) {
  user = {
    apiVersion: 0,
    appId: 'com.ekoaaapp.eko',
    deviceId: 'webapp2x0d724ffc9-6c91-48c4-934e-660c41d493db1525756917094',
    deviceModel: 'browser',
    deviceType: 'web',
    deviceVersion: '9.4.0',
    domain: '',
    username: user.username,
    password: user.password,
  }

  const options = {
    url: target,
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(user)
  }

  return new Promise((resolve, reject) => {
    request(options, (err, response, body) => {
      if (err) {
        return reject(err)
      }
      const bodyJson = JSON.parse(body)
      if (err) return reject(err)
      return resolve(bodyJson.accessToken)
    })
  })
}
