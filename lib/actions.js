var nodemiral = require('nodemiral');
var path = require('path');
var fs = require('fs');
var rimraf = require('rimraf');
var exec = require('child_process').exec;
//var spawn = require('child_process').spawn;
var uuid = require('uuid');
//var format = require('util').format;
//var extend = require('util')._extend;
var _ = require('underscore');
var async = require('async');
var buildApp = require('./build.js');
var ap = Actions.prototype;

require('colors');

module.exports = Actions;

function Actions(config, cwd, options) {
  this.cwd = cwd;
  this.config = config;
  this.sessionsMap = this._createSessionsMap(config);
  this.settingsFileName = options.settingsFileName;

  //get settingsFileName into env
  var setttingsJsonPath = path.resolve(this.cwd, this.settingsFileName);
  if(fs.existsSync(setttingsJsonPath)) {
    this.config.env['METEOR_SETTINGS'] = JSON.stringify(require(setttingsJsonPath));
  }
}

ap._createSessionsMap = function(config) {
  var sessionsMap = {};

  config.servers.forEach(function(server) {
    var host = server.host;
    var auth = {username: server.username};

    if(server.pem) {
      auth.pem = fs.readFileSync(path.resolve(server.pem), 'utf8');
    } else {
      auth.password = server.password;
    }

    var nodemiralOptions = {
      ssh: server.sshOptions,
      keepAlive: true
    };

    if(!sessionsMap[server.os]) {
      sessionsMap[server.os] = {
        sessions: [],
        taskListsBuilder:require('./taskLists')(server.os)
      };
    }

    var session = nodemiral.session(host, auth, nodemiralOptions);
    session._serverConfig = server;
    sessionsMap[server.os].sessions.push(session);
  });

  return sessionsMap;
};

var kadiraRegex = /^meteorhacks:kadira/m;
ap._showKadiraLink = function() {
  var versionsFile = path.join(this.config.app, '.meteor/versions');
  if(fs.existsSync(versionsFile)) {
    var packages = fs.readFileSync(versionsFile, 'utf-8');
    var hasKadira = kadiraRegex.test(packages);
    if(!hasKadira) {
      console.log(
        "“ Checkout " + "Kadira".bold + "!"+
        "\n  It's the best way to monitor performance of your app."+
        "\n  Visit: " + "https://kadira.io/mup".underline + " ”\n"
      );
    }
  }
}

ap._executePararell = function(actionName, args) {
  var self = this;
  var sessionInfoList = _.values(self.sessionsMap);
  async.map(
    sessionInfoList,
    function(sessionsInfo, callback) {
      var taskList = sessionsInfo.taskListsBuilder[actionName]
        .apply(sessionsInfo.taskListsBuilder, args);
      taskList.run(sessionsInfo.sessions, function(summaryMap) {
        callback(null, summaryMap);
      });
    },
    whenAfterCompleted
  );
};

ap.setup = function() {
  var args = process.argv.slice(3);
  if(args.indexOf("--mongoStomp") > -1) this.config.mongoStomp = true;
  else if(args.indexOf("--mongoUnlock") > -1) this.config.mongoUnlock = true;
  this._showKadiraLink();
  this._executePararell("setup", [this.config]);
};

ap.deploy = function() {
  var self = this;
  self._showKadiraLink();

  var buildLocation = path.resolve('/tmp', uuid.v4());
  var bundlePath = path.resolve(buildLocation, 'bundle.tar.gz');

  // spawn inherits env vars from process.env
  // so we can simply set them like this
  process.env.BUILD_LOCATION = buildLocation;

  var deployCheckWaitTime = this.config.deployCheckWaitTime;
  var appName = this.config.appName;
  var appPath = this.config.app;
  var buildOptions = this.config.buildOptions;

  console.log('Meteor app path    : ' + this.config.app);
  console.log('Using buildOptions : ' + JSON.stringify(buildOptions));
  buildApp(appPath, buildLocation, buildOptions, function(err) {
    if(err) {
      process.exit(1);
    } else {
      var sessionsData = [];
      _.forEach(self.sessionsMap, function (sessionsInfo) {
        var taskListsBuilder = sessionsInfo.taskListsBuilder;
        _.forEach(sessionsInfo.sessions, function (session) {
          sessionsData.push({
            taskListsBuilder: taskListsBuilder,
            session: session
          });
        });
      });

      async.mapSeries(
        sessionsData,
        function (sessionData, callback) {
          var session = sessionData.session;
          var taskListsBuilder = sessionData.taskListsBuilder;
          var env = _.extend({}, self.config.env, session._serverConfig.env);
          var taskList = taskListsBuilder.deploy(bundlePath, env, self.config);
          taskList.run(session, function (summaryMap) {
            callback(null, summaryMap);
          });
        },
        whenAfterDeployed(buildLocation)
      )
    }
  });
};

ap.reconfig = function() {
  var self = this;
  var sessionInfoList = [];
  for(var os in self.sessionsMap) {
    var sessionsInfo = self.sessionsMap[os];
    sessionsInfo.sessions.forEach(function(session) {
      var env = _.extend({}, self.config.env, session._serverConfig.env);
      var taskList = sessionsInfo.taskListsBuilder.reconfig(
        env, self.config);
      sessionInfoList.push({
        taskList: taskList,
        session: session
      });
    });
  }

  async.mapSeries(
    sessionInfoList,
    function(sessionsInfo, callback) {
      sessionsInfo.taskList.run(sessionsInfo.session, function(summaryMap) {
        callback(null, summaryMap);
      });
    },
    whenAfterCompleted
  );
};

ap.restart = function() {
  this._executePararell("restart", [this.config]);
};

ap.stop = function() {
  this._executePararell("stop", [this.config]);
};

ap.start = function() {
  this._executePararell("start", [this.config]);
};

ap.logs = function() {
  var self = this;
  var tailOptions = process.argv.slice(3).join(" ");

  var sessions = [];

  for(var os in self.sessionsMap) {
    var sessionsInfo = self.sessionsMap[os];
    sessionsInfo.sessions.forEach(function(session) {
      sessions.push(session);
    });
  }

  async.map(
    sessions,
    function(session, callback) {
      var hostPrefix = '[' + session._host + '] ';
      var options = {
        onStdout: function(data) {
          process.stdout.write(hostPrefix + data.toString());
        },
        onStderr: function(data) {
          process.stderr.write(hostPrefix + data.toString());
        }
      };

      var command = 'sudo docker logs ' + tailOptions + ' ' + self.config.appName;
      session.execute(command, options, callback);
    },
    whenAfterCompleted
  );
};

Actions.init  = function() {
  var destMupJson = path.resolve('mup.json');
  var destSettingsJson = path.resolve('settings.json');

  if(fs.existsSync(destMupJson) || fs.existsSync(destSettingsJson)) {
    console.error('A Project Already Exists'.bold.red);
    process.exit(1);
  }

  var exampleMupJson = path.resolve(__dirname, '../example/mup.json');
  var exampleSettingsJson = path.resolve(__dirname, '../example/settings.json');

  copyFile(exampleMupJson, destMupJson);
  copyFile(exampleSettingsJson, destSettingsJson);

  console.log('Empty Project Initialized!'.bold.green);

  function copyFile(src, dest) {
    var content = fs.readFileSync(src, 'utf8');
    fs.writeFileSync(dest, content);
  }
};

Date.prototype.defaultView = function(){
	var dd = this.getDate();
	if(dd < 10)dd = '0' + dd;
	var mm = this.getMonth() + 1;
	if(mm < 10) mm = '0' + mm;
	var yyyy = this.getFullYear();
	return String(yyyy + "-" + mm + "-" + dd);
};

String.prototype.endsWith = function (s) {
  return this.length >= s.length && this.substr(this.length - s.length) == s;
};

ap.dump = ap.md = ap.mb = ap.backup = ap.mongobackup = ap.mongoBackup = ap.mongoDump = ap.mongodump = function() {
  dockerIdSeach("mongo", "mongodb", "dockerId", prepMongoBackupRestore, "dump", this.config);
};

ap.restore = ap.mr = ap.mongoload = ap.mongoLoad = ap.ml = ap.load = ap.mongoRestore = ap.mongorestore  = function() {
  dockerIdSeach("mongo", "mongodb", "dockerId", prepMongoBackupRestore, "restore", this.config);
};

ap.unlock = ap.mu = ap.mul = ap.mongounlock = ap.mongoUnlock = ap.mongounlocklocal = ap.mongoUnlockLocal = ap.mongounlock  = function() {
  mongoUnlockLocal();
};

ap.unlockremote = ap.murt = ap.mongounlockremote = ap.unlockRemote = ap.mongoUnlockRemote = ap.mongounlockremote  = function() {
  dockerIdSeach("mongo", "mongodb", "dockerId", mongoUnlockRemote);
};

/* well this is just a way to verify or find the real docker ID ~ adds flexibility */
function dockerIdSeach(search, defaultId, store, success, args, config) {
  if(store === "") return;
  this.config = config = config || this.config || {}; // I know. I don't get it either. Codevolution@Work here.
  search = search || defaultId || "mongodb";
  exec("docker ps --format '{{.ID}}: {{.Command}} Names:{{.Names}}' | egrep '" + search + "' | sed 's/:.*//';", function (error, stdout) {
    if (error !== null) {
      console.log(error.toString().bold.red);
    }
    else {
      config[store] = stdout.toString().replace(/(\r\n|\n|\r)/gm, "");
      if(config.vbs) console.log(search + " = " + config[store]);
      if(success !== undefined) success(args);
    }
  });
}

function prepMongoBackupRestore(mode) {
  mode = mode || "dump";
  var config = this.config;
  config.appName = config.appName || "meteorApp";
  config.myArgs = process.argv.slice(3);
  var ma = config.myArgs;
  var vbs = config.vbs = (ma.indexOf("-v") > -1);
  var ld = '/opt/backups/';
  var idx, arg;
  for(idx = 0; idx < ma.length; idx++) {
    arg = (ma[idx]).toLowerCase();
    if(mode == "dump") {
      if(arg == "--o" || arg == "--out") {
        ld = ma[idx + 1];
        ma.splice(idx, 2);
        idx -= 1;
        if(vbs) console.log("Set Local Destination Folder (not filename):".bold.green, ld);
      }
    }
    else {
      if(arg == "--i" || arg == "--in") {
        ld = ma[idx + 1];
        ma.splice(idx, 2);
        idx -= 1;
        if(vbs) console.log("Set Local Source Folder (not filename):".bold.blue + ld);
      }
    }
    if(arg === "--cid" || arg === "--dockerid") {
      config.dockerId = ma[idx + 1];
      ma.splice(idx, 2);
      if(vbs) console.log("Set Target DockerID:".bold.blue + config.dockerId);
      idx -= 1;
    }
    else {
      if(arg === "--restoredumps") {
        config.restoreDumps = true;
        ma.splice(idx, 1);
        if (vbs) console.log("Set Restore Dumps".bold.blue);
        idx -= 1;
      }
      else {
        if(arg === "--nocleanup") {
          config.noCleanUp = true;
          ma.splice(idx, 1);
          if (vbs) console.log("Set No-CleanUp".bold.blue);
          idx -= 1;
        }
        else {
          if(idx == (ma.length - 1)) {
            ld = ma[idx];
            if(ld.indexOf("-") != 0) {
              ma.splice(idx, 1);
              idx -= 1;
              if(vbs) console.log("Set Local Source Folder (not filename):".bold.blue + ld);
            }
          }
        }
      }
    }
  }
  if(mode === "dump") {
    if(ld.endsWith("/") == false) ld += "/";
  }
  else {
    if(ld.endsWith("/") == true) ld = ld.substring(0, (ld.length - 1));
  }
  if(vbs) console.log(ma);
  fs.exists(ld, function(exists) {
    if(exists) {
      config.locDir = ld;
      runMongoDumpRestore(mode);
    }
    else {
      console.log("Error: Local Directory Not Found ".bold.red + ld);
    }
  });
}

function runMongoDumpRestore(mode) {
  var config = this.config;
  var mCon = config.dockerId;
  if(mCon === undefined || mCon === "") {
    console.log(('No Mongod Docker found running Aborting ' + mode).bold.red);
    return;
  }
  console.log("Mongo Container: ".bold.cyan + mCon);
  var ld = config.locDir;
  var fName, genName = config.genName = "MDump_" + config.appName + "_" + (new Date).defaultView();
  if(ld === '/opt/backups/') fName = (ld + genName);
  else fName = ld;
  if(mode === "dump") {
    runDumpRestore(mode, "/opt/backups/" + genName, fName);
  }
  else {
    var cpTarg = mCon + ":/opt/backups/" + genName;
    var cmd = "sudo docker cp " + fName + " " + cpTarg;
    console.log("Transferring: " + fName + "  " + String.fromCharCode(8631).bold.green + "  " + cpTarg);
    execCommand(cmd, cpTarg + " Restoring!", function () {runDumpRestore(mode, fName, "/opt/backups/" + genName);});
  }
  /* NOTE: Execution reaches here before the exec's get to run for very long */
}

function runDumpRestore(mode, fName, cpTarg) {
  var config = this.config;
  var mCon = config.dockerId;
  var ld = config.locDir;
  var vbs = config.vbs;
  var cmd = "sudo docker exec -t " + mCon;
  if(mode === "dump") {
    cmd += " mongodump --out " + fName + " " + config.myArgs.join(" ");
  }
  else {
    cmd += " mongorestore ";
    var drop = config.restoreDrops || config.env.RESTORE_DROPS || process.env.RESTORE_DROPS || true;
    if(drop === true || drop === 'true' || drop === '1') {
      cmd += "--drop ";
    }
    cmd += config.myArgs.join(" ") + " " + cpTarg;
  }
  if(vbs) console.log(cmd);
  exec(cmd, function (error, stdout) {
    if(error !== null) console.log(error.toString().bold.red);
    else {
      var dumpOp = stdout.toString();
      if(dumpOp.length > 0) {
        if(vbs) console.log("Mongo Dump/Restore Results (" + dumpOp.length + "):\n" + dumpOp);
        if(dumpOp.toLowerCase().indexOf("failed") == -1) {
          if(mode === "dump") {
            if(!fs.existsSync(ld)) {
              fs.mkdirSync(ld);
            }
            cmd = "sudo docker cp " + mCon + ":" + fName + " " + ld;
            if(vbs) console.log(cmd);
            ld += (cpTarg.indexOf(config.genName) == -1)?config.genName:"";
            console.log("Transferring: " + ld + "  " + String.fromCharCode(8630).bold.green + "  " + fName);
            execCommand(cmd, ld + " Complete!", function() {cleanUpRemote(mCon, fName);});
          }
          else {
            cleanUpRemote(mCon, cpTarg);
          }
        }
        else {
          console.log("Error: Failure 'done' NOT Detected".bold.red);
        }
      }
      else {
        console.log("No report from mongodump".bold.red);
      }
    }
  });
}

function cleanUpRemote(mCon, fName) {
  var config = this.config;
  var noCleanUp = config.noCleanUp || config.env.NO_CLEANUP || process.env.NO_CLEANUP || false;
  if(noCleanUp === false || noCleanUp === 'false' || noCleanUp === '0') {
    execCommandOn(mCon, "rm -r " + fName, "Clean-Up done for " + fName);
  }
}

function mongoUnlockLocal() {
  console.log("mongoUnlockLocal removing /var/lib/mongodb/mongod.lock from Local");
  execCommand("sudo rm /var/lib/mongodb/mongod.lock", "Local Lock Removed /var/lib/mongodb/mongod.lock");
}

function mongoUnlockRemote() {
  var dockerId = this.config.dockerId;
  console.log("mongoUnlockRemote removing /data/db/mongod.lock from " + dockerId);
  execCommandOn(dockerId, "rm /data/db/mongod.lock", "Lock Removed /data/db/mongod.lock");
}

function execCommandOn(mCon, cmd, successMsg, callback, args) {
  if(mCon === undefined || mCon === "" || cmd === undefined || cmd === "") {
    console.log("execCommandOn~ Command Not Valid! try running 'setup' maybe?");
    return;
  }
  execCommand("sudo docker exec -t '" + mCon + "' " + cmd, mCon + ": " + successMsg, callback, args);
}

function execCommand(cmd, successMsg, callback, args) {
  exec(cmd, function (error, stdout, stderr) {
    if(error !== null) {
      console.log(stdout.toString().bold.red);
      console.log(error.toString().bold.red);
    }
    else {
      console.log(stdout.toString().bold.green);
      console.log(successMsg.toString().bold.green);
      if(callback !== undefined) callback(args);
    }
  });
}

function whenAfterDeployed(buildLocation) {
  return function(error, summaryMaps) {
    rimraf.sync(buildLocation);
    whenAfterCompleted(error, summaryMaps);
  };
}

function whenAfterCompleted(error, summaryMaps) {
  var errorCode = error || haveSummaryMapsErrors(summaryMaps) ? 1 : 0;
  process.exit(errorCode);
}

function haveSummaryMapsErrors(summaryMaps) {
  return _.some(summaryMaps, hasSummaryMapErrors);
}

function hasSummaryMapErrors(summaryMap) {
  return _.some(summaryMap, function (summary) {
    return summary.error;
  })
}
