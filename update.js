#!/usr/bin/node
var config=require('./config.js')
var select = require('soupselect').select;
var htmlparser = require("htmlparser");
var http = require('http');
var fs = require('fs');
var util=require('util');
var querystring = require('querystring');
var readline = require('readline');
var printf = require('printf');
var RconModule = require('rcon');

try {
  var versions = require('./.bukkit-updater.versions.json');
} catch(e) {
  var versions = [];
}

var queries = [
  { r: { hostname: 'dl.bukkit.org', path: '/' }, cb: latestCB, el: 'div#downloadButton span', file: 'craftbukkit.jar', url:'http://dl.bukkit.org/latest-rb/craftbukkit.jar', lfile:config.bukkitdir+'/craftbukkit.jar' },
  { r: { hostname: 'dl.bukkit.org', path: '/' }, cb: latestCB, el: 'div#downloadButtonBeta span', file: 'craftbukkit-beta.jar', url:'http://dl.bukkit.org/latest-beta/craftbukkit-beta.jar', lfile:config.bukkitdir+'/craftbukkit.jar'},
];

function latestCB(tr, q) {
    var info=tr.children[0].data.replace(/^\s*/g, '').replace(/\s*$/g, '');
    var v=info.match(/[0-9]*\.[0-9]*\.[0-9].[^ ]*/);
    if(v) {
      q.ver=v[0];
      q.cbver=v[0];
    }
}

function latestPlugin(tr, q) {
  var a = select(tr, 'td.col-file a');
  var na = select(tr, 'td.col-file');
  var vs = select(tr, 'td.col-game-version li');
  var fn = select(tr, 'td.col-filename');
  if(q.cnt >= 1)
    return;
  var ext=/\.jar/;
  if(q.lfile.match(/\.zip/))
    ext=/\.zip/;
  if(fn[0] && fn[0].children[0].data.match(ext)){
    q.cnt++;
    var jar=fn[0].children[0].data.replace(/\s*/g, '');
    if(a[0])
      q.link=a[0].attribs.href;
    q.file=jar;
    q.cbver=[];
    q.ver=a[0].children[0].data.replace(/\s+/g, ' ');
    vs.forEach(function(v) {
      q.cbver.push(v.children[0].data);
    });
  }
}

function pluginUrl(a, q) {
  q.url=a.attribs.href+'';
}

for(i in config.plugins) {
  var p=config.plugins[i];
  queries.push( { r: { hostname: 'dev.bukkit.org', path: '/bukkit-plugins/'+p.name+'/files/' }, cb: latestPlugin, el: 'table.listing tr', lfile:config.bukkitdir+'/plugins/'+p.lfile });
}

for(i in queries){
  var q=queries[i];
  q.cnt=0;
  query(q, function(res) { 
    if(res.r.hostname=='dev.bukkit.org') {
      res.r.path=res.link;
      res.cb = pluginUrl;
      res.el = 'li.user-action-download a'
      query(res, addResult);
    } else
      addResult();
  } );
}

var cnt=0;
function addResult(){
  cnt++; 
  var dlcnt=0;
  if(cnt==queries.length) {
    if(queries[0].ver > queries[1].ver)
      queries[1].skip=1;
    else
      queries[0].skip=1;
    process.stdout.write("\n");
    var strlens=[0,0,0];
    for(i in queries){
      var q=queries[i];
      strlens[0] = Math.max(strlens[0], q.file.length);
      strlens[1] = Math.max(strlens[1], q.ver.length);
      strlens[2] = Math.max(strlens[2], util.isArray(q.cbver) ? q.cbver.join(",").length : q.cbver.length);
    }
    for(i in queries){
      var q=queries[i];
      if(q.ver <= versions[q.lfile])
        q.skip=1;
      //printf(process.stdout, '%-'+strlens[0]+'s : %-'+strlens[1]+'s %-6s : %-'+strlens[2]+'s : %-30s\n', q.file, q.ver, q.skip ? "(skip)" : "", q.cbver, q.url);
      printf(process.stdout, '%-'+strlens[0]+'s : %-'+strlens[1]+'s %-6s : %-'+strlens[2]+'s\n', q.file, q.ver, q.skip ? "(skip)" : "", q.cbver);
      if(!q.skip)
        dlcnt++;
    }
    if(process.stdin.isTTY && dlcnt) {
      var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      rl.question("Download [Y/n]? ", function(answer) {
        rl.close();
        if(answer.toLowerCase() == 'y' || answer == '') {
          stopServer();
          var cnt=0;
          var cntok=0;
          var downloads=new Object;
          for(i in queries){
            var q=queries[i];
            if(!q.skip) {
              cnt++;
              dl(q, function(dl) {
                cntok++;
                console.log(dl.lfile + ": " + cntok + "/" + cnt);
                downloads[dl.lfile]=dl.ver;
                if(cntok == cnt) {
                  fs.writeFileSync(__dirname+'/.bukkit-updater.versions.json', JSON.stringify(downloads), 'binary');
                }
              });
            } else {
              downloads[q.lfile]=q.ver;
            }
          }
        }
      });
    }
  }
}

function query(q, ready) {
  var req = http.request(q.r, function(res) {
    //    console.log('STATUS: ' + res.statusCode);
    //    console.log('HEADERS: ' + JSON.stringify(res.headers));
    res.setEncoding('utf-8');
    var data='';
    res.on('data', function (chunk) {
      data += chunk;
    });
    res.on('end', function () {
      var handler = new htmlparser.DefaultHandler(function(err, dom) {
        if (err) {
          console.error("Error: " + err);
        } else {
          var trs = select(dom, q.el);
          var csvline='';
          if(trs.length == 0) {
            console.log(data);
            console.error("Error: no element matches '"+q.el+"'");
            return;
          }
          process.stdout.write(".");
          trs.forEach(function(el) { q.cb(el, q) });
          if(ready)
            ready(q);
        }
      });
      var parser = new htmlparser.Parser(handler);
      parser.parseComplete(data);
    });
    req.on('error', function(e) {
      console.log('problem with request: ' + e.message);
    });
  });
  req.end();
};

function dl(q, callback) {
  if(q.skip)
    return;
  var req = http.get(q.url, function(res) {
    if(res.statusCode >= 300 && res.statusCode < 400) {
      process.stdout.write("R");
      q.url=res.headers.location;
      dl(q, callback);
      return;
    }
    var iszip=q.lfile.match(/\.zip/);
    var data='';
    if(!iszip)
      var fh = fs.createWriteStream(q.lfile);
    res.on('data', function (chunk) {
      if(iszip)
        data+=chunk.toString('binary');
      else
        fh.write(chunk);
      process.stdout.write(".");
    });
    res.on('end', function () {
      if(iszip) {
        process.stdout.write(" ("+res.headers['content-length']+" bytes read)\n");
        var zip = new require('node-zip')(data, {base64: false, checkCRC32: true});
        for(filepath in zip.files) {
          var file = zip.files[filepath];
          process.stdout.write("Unzipping to "+config.bukkitdir+'/plugins/'+filepath+"\n");
          fs.writeFileSync(config.bukkitdir+'/plugins/'+filepath, file.data, 'binary');
          q.downloaded=true;
        }
      } else {
        fh.on('close', function() {
          process.stdout.write("\ndownloaded "+q.url);
          process.stdout.write(" ("+res.headers['content-length']+" bytes, "+fh.bytesWritten+" bytes written)\n");
          q.downloaded=true;
        });
        fh.end();
      }
    callback(q);
    });
    req.on('error', function(e) {
      console.log('problem with request: ' + e.message);
    });
  });
};

function stopServer() {
  var rcon = new RconModule(config.rcon.host, config.rcon.port, config.rcon.password);
  rcon.on('auth', function() {
    console.log('authenticated to rcon.');
    rcon.send("stop");
  }).on('connect', function() {
    console.log('rcon connected.');
  }).on('error', function(str) {
    console.log('rcon error: '+str);
  }).on('response', function(str) {
    console.log('rcon response: '+str);
    rcon.disconnect();
  }).on('end', function() {
    console.log('rcon closed.');
  });
  rcon.connect();
}

