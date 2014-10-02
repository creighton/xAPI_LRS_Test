/* global featureFile, scenarios, steps, after, _suiteCfg */
"use strict";

var Yadda = require("yadda"),
    Glob = require("glob").Glob,
    crypto = require("crypto"),
    stringify = require("json-stable-stringify"),
    libraries = [ require("../steps/base.js"), require("../steps/verify.js") ],
    utilRequest = require("../utils/request"),
    utilCleanup = require("../utils/cleanup"),
    interpreterContext = {},
    runner = new Yadda.Yadda(libraries, interpreterContext),

    // the Glob instance used to find the files and directories
    // based on the _suiteCfg.stage1.featureSpec provided via the requires in
    // the Gruntfile
    g,

    // list of non-directory files found by the glob
    files = [],

    // list of directories found by the glob
    dirs = [],

    // a cache of the feature files that have already been run
    // since features may be found as part of a directory and
    // on their own, but we only ever want to run them once
    cache = {},

    // an object of all hashes seen during this test run
    hashes = {},
    markPending = {};

require("../fixtures");

Yadda.plugins.mocha.StepLevelPlugin.init();

Object.keys(_suiteCfg.stage1.pending).forEach(
    function (key) {
        _suiteCfg.stage1.pending[key].forEach(
            function (id) {
                markPending[id] = key;
            }
        );
    }
);

//
// simple routine that takes a file name to pass to the Yadda runner
// and cache it so that it only ever gets run once
//
function runFeatureFile (file) {
    if (cache[file]) {
        return;
    }

    cache[file] = true;

    featureFile(
        file,
        function (feature) {
            var featureResource = {};

            feature.scenarios.forEach(
                function (scenario) {
                    var hashable = [];
                    scenario.steps.forEach(
                        function (step) {
                            if (/^Given log/i.test(step)) {
                                return;
                            }

                            hashable.push(step);
                            scenario.lastStep = step;
                        }
                    );

                    scenario.stepHash = crypto.createHash("md5").update(JSON.stringify(hashable), "utf8").digest("hex");
                    hashes[scenario.stepHash] = false;

                    if (_suiteCfg.diagnostics.stepHash) {
                        scenario.title += " (" + scenario.stepHash + ")";
                    }

                    if (markPending[scenario.stepHash]) {
                        scenario.title = "PENDING (" + markPending[scenario.stepHash] + "): " + scenario.title;
                        scenario.annotations.pending = true;
                    }
                }
            );

            scenarios(
                feature.scenarios,
                function (scenario) {
                    var scenarioResource = {
                            cleanUpRequests: []
                        },
                        trace = [];

                    steps(
                        scenario.steps,
                        function (step, done) {
                            var context = {
                                featureResource: featureResource,
                                scenarioResource: scenarioResource,
                                trace: trace,
                                hash: scenario.stepHash,
                                isLast: (step === scenario.lastStep)
                            };

                            trace.push(step);

                            runner.yadda(
                                step,
                                context,
                                function (err, info) {
                                    if (this.isLast && this.scenarioResource.cleanUpRequests.length > 0) {
                                        utilRequest.makeRequestSeries(
                                            this.scenarioResource.cleanUpRequests,
                                            function () {
                                                done(err, info);
                                            }
                                        );
                                        return;
                                    }

                                    done(err, info);
                                }.bind(context)
                            );
                        }
                    );
                }
            );
        }
    );
}

//
// have to use a sync call here because of how Mocha handles
// the test files, the async versions never reached the callback
// capture the instance so that we can leverage the cache that
// glob builds for determining whether a file is a directory or
// not since we handle them differently
//
g = new Glob(
    _suiteCfg.stage1.featureSpec,
    {
        sync: true
    }
);

//
// g.found is the list of all matches (dirs + files)
//
g.found.forEach(
    function (match) {
        //
        // files are represented in the object as either 1 or true
        //
        if (g.cache[match] === 1 || g.cache[match] === true) {
            files.push(match);
        }
        //
        // directories are represented as either 2 or an array
        //
        else if (g.cache[match] === 2 || Array.isArray(g.cache[match])) {
            dirs.push(match);
        }
    }
);

dirs.forEach(
    function (dir) {
        new Yadda.FeatureFileSearch(dir).each(
            function (file) {
                runFeatureFile(file);
            }
        );
    }
);
files.forEach(
    function (file) {
        runFeatureFile(file);
    }
);

after(
    function () {
        var stalePending = {},
            missingCleanupObj = utilCleanup.missing(),
            missingCleanupKeys,
            i,
            len;

        if (_suiteCfg.diagnostics.requestCount) {
            utilRequest.stat(_suiteCfg._logger);
        }

        //
        // to keep them unique internally the missing implementation
        // is an object, but we store an array externally and to get
        // the right formatted JSON output the array separate from
        // the individual records
        //
        missingCleanupKeys = Object.keys(missingCleanupObj);
        if (missingCleanupKeys.length > 0) {
            _suiteCfg._logger("[");
            for (i = 0, len = missingCleanupKeys.length; i < len; i += 1) {
                _suiteCfg._logger(stringify(missingCleanupObj[missingCleanupKeys[i]]) + (i + 1 < len ? "," : ""));
            }
            _suiteCfg._logger("]");
        }

        //
        // if they didn't provide a featureSpec via the command line
        // then we can assume that the featureSpec via the config is
        // intended to match the pending, or that there was no featureSpec
        // in the config and therefore they are running them all which
        // means that we can check the pending list for any hashes that
        // don't still exist in the test suite and indicate they can be
        // removed
        //
        if (! _suiteCfg.stage1._featureSpecFromCLI && _suiteCfg.stage1.stalePending) {
            Object.keys(markPending).forEach(
                function (hash) {
                    if (typeof hashes[hash] === "undefined") {
                        stalePending[hash] = markPending[hash];
                    }
                }
            );
            if (Object.keys(stalePending).length > 0) {
                _suiteCfg._logger("Stale Pending Hashes");
                _suiteCfg._logger(stalePending);
                _suiteCfg._logger("---------------");
            }
        }
    }
);
