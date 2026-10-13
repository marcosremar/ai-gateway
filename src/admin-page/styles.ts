export const CSS = `
:root{color-scheme:light dark;--bg:#f4f5f7;--panel:#fff;--side:#ebedf1;--line:#dfe2e7;--line2:#eceef2;--hover:#f6f7f9;--text:#15171b;--muted:#585e6a;
--accent:#2a4fd6;--ok:#11744a;--warn:#875200;--bad:#b42318;--bar:#9aa3b2;--c0:#2a4fd6;--c1:#c2410c;--c2:#0f766e;--c3:#8b3fd9;--c4:#a16207;--c5:#5b6472;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f12;--panel:#15181c;--side:#101216;--line:#262a31;--line2:#1d2026;--hover:#1a1d22;--text:#e7e9ed;
--muted:#9ba2ae;--accent:#86a0ff;--ok:#4fcf8a;--warn:#efb558;--bad:#ff8a7c;--bar:#4a5260;--c0:#86a0ff;--c1:#fb923c;--c2:#2dd4bf;--c3:#c4a1ff;--c4:#facc15;--c5:#9ba2ae}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-padding-top:16px}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
::selection{background:color-mix(in srgb,var(--accent) 28%,transparent)}
a{color:inherit;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.info{--lvl:var(--accent)}.ok{--lvl:var(--ok)}.warn{--lvl:var(--warn)}.bad{--lvl:var(--bad)}
code,.mono{font-family:var(--mono);font-size:12.5px}
.mark{display:inline-flex;flex:none;color:var(--lvl)}.mark svg{width:16px;height:16px;overflow:visible}
.mark .s{fill:currentColor}.mark .g{fill:none;stroke:var(--panel);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.shell{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:var(--side);border-right:1px solid var(--line);padding:16px 12px}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 18px;font-weight:650;font-size:15px}
.brand svg{width:22px;height:22px;color:var(--accent)}.brand small{color:var(--muted);font-weight:500;font-size:12px}
.nav{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.nav a{display:flex;align-items:center;gap:10px;min-height:38px;padding:0 10px;border-radius:9px;text-decoration:none;color:var(--muted);font-weight:550}
.nav a:hover{background:color-mix(in srgb,var(--text) 6%,transparent);color:var(--text)}
.nav .ic{width:18px;height:18px;flex:none}.nav a .mark{margin-left:auto}.nav a .mark svg{width:14px;height:14px}
.nav a.cur{background:var(--panel);color:var(--text);box-shadow:0 1px 2px rgb(0 0 0/.07),0 0 0 1px var(--line)}.nav a.cur .ic{color:var(--accent)}
.foot{margin-top:auto;padding:12px 8px 0;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
.foot b{color:var(--text);font-weight:600}.foot form{margin-top:8px}
.main{min-width:0;padding:28px 36px 0;max-width:1320px;display:flex;flex-direction:column;min-height:100vh}
.main>.bar{margin-top:auto}
.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;padding:12px 16px;margin:0}
.facts dt{color:var(--muted)}.facts dd{margin:0;overflow-wrap:anywhere}
pre.log{margin:0;padding:12px 16px;font:12px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:70vh;overflow:auto}
h1{font-size:24px;line-height:1.2;margin:0;letter-spacing:-.015em;font-weight:680}
.hero{display:flex;align-items:flex-start;gap:14px;margin:4px 0 18px}
.hero .mark svg{width:30px;height:30px}.hero .mark .g{stroke-width:2.2}.hero p{margin:4px 0 0;color:var(--muted);font-size:13px}
.ph{margin:4px 0 18px}.ph p{margin:6px 0 0;color:var(--muted);max-width:70ch}
.pt{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px}.pt h1{overflow-wrap:anywhere}.pt h1.mono{font-size:22px;letter-spacing:0}.pt .acts{display:flex;gap:8px;margin-left:auto}
.crumb{margin:0 0 6px;color:var(--muted);font-size:13px}.crumb a{color:var(--accent);text-decoration:none}.crumb a:hover{text-decoration:underline}
.aula{display:flex;align-items:center;gap:12px;padding:12px 16px;margin:0 0 16px;border-radius:12px;background:var(--panel);border:1px solid var(--line)}
.aula b{display:block;font-weight:650}.aula span:not(.live):not(.idle){color:var(--muted);font-size:13px}
.aula.on{background:color-mix(in srgb,var(--ok) 9%,var(--panel));border-color:color-mix(in srgb,var(--ok) 35%,var(--line))}
.live,.idle{flex:none;width:10px;height:10px;border-radius:50%;background:var(--bar)}
.live{background:var(--ok);box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 45%,transparent);animation:pulse 2s ease-out infinite}
@keyframes pulse{to{box-shadow:0 0 0 8px transparent}}@media (prefers-reduced-motion:reduce){.live{animation:none}}
section.turns.on{border-color:color-mix(in srgb,var(--lvl) 40%,var(--line))}section.turns.on>.sh{background:color-mix(in srgb,var(--lvl) 8%,var(--panel))}
.stats.turn{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 24px}.stats.turn b{display:flex;align-items:center;gap:6px}
.stats b.warn,.stats b.bad{color:var(--lvl)}.stats b .mark svg{width:14px;height:14px}
.lat{display:block;width:100%;max-width:240px;height:12px;margin:6px 0 4px}
.lat .z0{fill:color-mix(in srgb,var(--ok) 30%,transparent)}.lat .z1{fill:color-mix(in srgb,var(--warn) 40%,transparent)}.lat .z2{fill:color-mix(in srgb,var(--bad) 30%,transparent)}
.lat .p50{fill:var(--muted)}.lat .p95{fill:var(--text)}code.rid{overflow-wrap:anywhere;user-select:all}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 20px}
.card{display:flex;flex-direction:column;gap:4px;padding:14px 16px;border-radius:12px;background:var(--panel);border:1px solid var(--line);text-decoration:none;min-width:0;
transition:border-color .15s ease-out,box-shadow .15s ease-out}
.card:hover{border-color:color-mix(in srgb,var(--muted) 45%,var(--line));box-shadow:0 2px 8px rgb(0 0 0/.06)}
.card.warn{border-color:color-mix(in srgb,var(--warn) 40%,var(--line))}.card.bad{border-color:color-mix(in srgb,var(--bad) 50%,var(--line))}
.ch{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12.5px;font-weight:600}.ch .ic{width:16px;height:16px}.ch .mark{margin-left:auto}
.cv{font-size:16.5px;font-weight:650;letter-spacing:-.01em;line-height:1.3;font-variant-numeric:tabular-nums}
.cf{color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums}
.card ul{margin:6px 0 0;padding:0 0 0 16px;font-size:13px}.card li{margin:2px 0}.card li.more{list-style:none;margin-left:-16px;color:var(--muted)}
.card .go{margin-top:auto;padding-top:8px;color:var(--accent);font-size:12.5px;font-weight:600}
.jump{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px}
.jump a{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--line);background:var(--panel);text-decoration:none;font-size:13px;font-weight:550}
.jump a:hover{background:var(--hover)}.jump .n{color:var(--muted);font-variant-numeric:tabular-nums}.jump .mark svg{width:13px;height:13px}
.msg{display:flex;gap:8px;align-items:center;padding:10px 14px;border-radius:10px;background:var(--panel);border:1px solid var(--line);margin:0 0 16px}
.msg.bad{border-color:color-mix(in srgb,var(--bad) 45%,var(--line))}.msg small{display:block;color:var(--muted)}
.scope{margin:-8px 0 20px;padding:10px 14px;border-radius:8px;background:color-mix(in srgb,var(--accent) 9%,var(--panel));border:1px solid color-mix(in srgb,var(--accent) 30%,var(--line))}
.scope small{display:block;color:var(--muted);font-size:12.5px;margin-top:2px}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:20px;scroll-margin-top:16px;overflow:hidden}
.sh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}
h2{font-size:15px;font-weight:650;margin:0}
.sh .meta{color:var(--muted);font-size:12.5px}.sh .acts{margin-left:auto;display:flex;gap:8px}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;line-height:20px;padding:0 8px 0 6px;border-radius:999px;white-space:nowrap;
color:var(--lvl);background:color-mix(in srgb,var(--lvl) 12%,transparent)}
.msg .pill,.lk .pill{white-space:normal}.pill .mark svg{width:13px;height:13px}.pill .mark .g{stroke:color-mix(in srgb,var(--lvl) 12%,var(--panel))}
.sub{padding:12px 16px 4px;margin:0;font-size:12.5px;font-weight:600;color:var(--muted)}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font-size:12px;font-weight:600;color:var(--muted);padding:8px 16px;border-bottom:1px solid var(--line);white-space:nowrap;background:color-mix(in srgb,var(--side) 45%,var(--panel))}
td{padding:7px 16px;border-bottom:1px solid var(--line2);vertical-align:top}
tbody tr:last-child td{border-bottom:0}tbody tr:hover td{background:var(--hover)}
th.n,td.n{text-align:right;white-space:nowrap}
td small{display:block;color:var(--muted);font-size:12.5px;margin-top:1px}td .v{min-width:0}
td b{font-weight:600}td .err{color:var(--bad)}
.use{display:block;width:96px;height:4px;margin:5px 0 0 auto;border-radius:2px}.use .t{fill:var(--line)}.use .f{fill:var(--lvl,var(--accent))}
.empty{padding:16px;color:var(--muted);margin:0}
.stats{display:flex;flex-wrap:wrap;gap:8px 32px;padding:12px 16px;border-bottom:1px solid var(--line2)}
.stats div{display:flex;flex-direction:column}.stats span{color:var(--muted);font-size:12.5px}.stats b{font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}
.stats small{color:var(--muted);font-size:12.5px;max-width:28ch}
.chart{padding:14px 16px 6px;border-bottom:1px solid var(--line2)}
.chart svg{display:block;width:100%;height:120px}.chart .bs{fill:var(--bar)}.chart .bf{fill:var(--bad)}.chart .hit{fill:transparent}
.chart g:hover .bs{fill:var(--muted)}.chart .gl{stroke:var(--line)}
.cmax{text-align:right;color:var(--muted);font-size:12px;margin-bottom:4px;font-variant-numeric:tabular-nums}
.ticks{display:grid;grid-template-columns:repeat(24,1fr);color:var(--muted);font-size:11px;margin-top:4px;font-variant-numeric:tabular-nums}.ticks span{white-space:nowrap}.legend{display:flex;gap:16px;color:var(--muted);font-size:12px;margin-top:6px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}.legend .ls{background:var(--bar)}.legend .lf{background:var(--bad)}
.c0{--c:var(--c0)}.c1{--c:var(--c1)}.c2{--c:var(--c2)}.c3{--c:var(--c3)}.c4{--c:var(--c4)}.c5{--c:var(--c5)}
.spend rect[class^=c]{fill:var(--c)}.spend g:hover rect[class^=c]{opacity:.8}.legend i[class^=c],.sw{background:var(--c)}
.sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:7px;vertical-align:0}
.ticks.d30{grid-template-columns:repeat(30,1fr)}
.foot-note{margin:0;padding:10px 16px 12px;color:var(--muted);font-size:12px;border-top:1px solid var(--line2)}
.recos{list-style:none;margin:0;padding:0}
.incs{list-style:none;margin:0;padding:0}.incs li{display:flex;gap:10px;padding:10px 16px;border-top:1px solid var(--line2)}.incs li:first-child{border-top:0}
.incs li>.mark{margin-top:2px}.incs li>div{min-width:0}.incs small{display:block;color:var(--muted);font-size:12.5px}.incs .mono{color:var(--muted);overflow-wrap:anywhere}
td details summary{cursor:pointer;color:var(--muted);font-size:12.5px}
.saving{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;margin:0;padding:12px 16px;border-bottom:1px solid var(--line2)}
.saving span{color:var(--muted);font-size:12.5px;flex-basis:100%}.saving b{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--ok)}
.saving small{color:var(--muted);font-size:12.5px}
.digest{margin:0;padding:8px 16px;color:var(--muted);font-size:12.5px;border-bottom:1px solid var(--line2)}
.reco{display:flex;gap:12px;padding:12px 16px;border-top:1px solid var(--line2)}.reco:first-child{border-top:0}.reco>.mark{margin-top:2px}
.rb{flex:1;min-width:0}.rt{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.amt{margin-left:auto;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap}
.reco dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:6px 0 8px;font-size:13px}
.reco dt{color:var(--muted);font-size:12px;font-weight:600;padding-top:1px}.reco dd{margin:0;min-width:0;overflow-wrap:anywhere}
.ra{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.ra code{padding:3px 7px;border-radius:6px;background:var(--hover);border:1px solid var(--line2);overflow-wrap:anywhere}
.ra .t{color:var(--muted);font-size:12.5px}
button.quiet{border-color:transparent;background:none;color:var(--muted);font-weight:500}button.quiet:hover{color:var(--text)}
.bar{position:sticky;bottom:0;z-index:1;display:flex;flex-wrap:wrap;gap:4px 18px;margin:8px -36px 0;padding:8px 36px;
background:color-mix(in srgb,var(--bg) 92%,transparent);border-top:1px solid var(--line);color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.recos{list-style:none;margin:0;padding:0}
.reco details{margin:4px 0 6px}.reco summary{cursor:pointer;color:var(--muted);font-size:12.5px;width:max-content;min-height:24px}
.reco summary:hover{color:var(--text)}
details.more{border-top:1px solid var(--line2)}details.more>summary{cursor:pointer;padding:12px 16px;color:var(--muted);font-weight:600;font-size:13px}
details.more>summary:hover{color:var(--text)}details.more[open]>summary{border-bottom:1px solid var(--line2)}
.gapp{padding:4px 0 8px;border-top:1px solid var(--line2)}.gapp:first-child{border-top:0}.gapp .sub{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--text)}
.gapp .sub .t{color:var(--muted);font-weight:500;font-size:12px}.lost{margin:0 16px 8px;padding:8px 12px;border-radius:8px;font-size:12.5px;background:color-mix(in srgb,var(--warn) 10%,var(--panel));color:var(--text)}
.svc{margin:0 16px 10px;border:1px solid var(--line2);border-radius:9px;overflow:hidden}
.svh{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 12px;background:color-mix(in srgb,var(--side) 45%,var(--panel));border-bottom:1px solid var(--line2)}.svh .pill{margin-left:auto}
.chain{list-style:none;margin:0;padding:0}.chain li{display:flex;gap:10px;padding:8px 12px;border-top:1px solid var(--line2)}.chain li:first-child{border-top:0}
.chain li.now{background:color-mix(in srgb,var(--accent) 8%,var(--panel));box-shadow:inset 3px 0 0 var(--accent)}
.chain .ix{flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11.5px;font-weight:650;background:var(--hover);border:1px solid var(--line);font-variant-numeric:tabular-nums}
.lk{min-width:0;flex:1}.lk>div{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}.lk small{display:block;color:var(--muted);font-size:12px;margin-top:2px}.lk small.inl{display:inline;margin:0}
.lk code{overflow-wrap:anywhere}
.filter{padding:10px 16px;margin:0;border-bottom:1px solid var(--line2);color:var(--muted)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 12px;border-radius:7px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit;font-weight:600;font-size:13px;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{background:var(--hover);border-color:color-mix(in srgb,var(--muted) 50%,var(--line))}button:active{transform:translateY(1px)}
.danger{color:var(--bad)}
.foot button{width:100%}
.login{max-width:400px;margin:12vh auto;padding:0 16px}.login .brand{padding:0 0 20px}
.login section{padding:20px}.login p{color:var(--muted)}
.login label{display:block;font-weight:600;margin-bottom:6px}
input[type=password]{width:100%;min-height:44px;padding:0 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
.login button{width:100%;min-height:44px;margin-top:14px;background:var(--text);color:var(--panel);border-color:var(--text)}
@media (max-width:1100px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:900px){.shell{display:block}
.side{position:sticky;top:0;z-index:3;height:auto;flex-direction:row;align-items:center;padding:6px 16px;padding-top:max(6px,env(safe-area-inset-top));border-right:0;border-bottom:1px solid var(--line)}
.brand{padding:4px 0;flex:1;min-width:0}.foot{margin:0;padding:0;border:0}.foot .who{display:none}.foot form{margin:0}.foot button{width:auto}
.side nav{position:fixed;left:0;right:0;bottom:0;z-index:3;background:var(--side);border-top:1px solid var(--line);padding:4px 4px max(4px,env(safe-area-inset-bottom))}
.nav{flex-direction:row;gap:0}.nav li{flex:1;min-width:0}
.nav a{flex-direction:column;justify-content:center;gap:2px;min-height:52px;padding:4px 0;font-size:11px;font-weight:600;position:relative;border-radius:10px}
.nav a.cur{box-shadow:none;background:none;color:var(--accent)}.nav .ic{width:22px;height:22px}
.nav a .mark{position:absolute;top:3px;left:calc(50% + 7px);margin:0}.nav a .mark svg{width:13px;height:13px}
.nav .lb{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.main{padding:16px 16px 0;min-height:0}.main>.bar{margin:16px -16px 0;padding:10px 16px calc(78px + env(safe-area-inset-bottom));position:static;flex-wrap:wrap}
section,.hero{scroll-margin-top:72px}.cards{grid-template-columns:1fr}.stats.turn{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:640px){h1{font-size:21px}.sh .acts{margin-left:0;width:100%}.sh .acts button{width:100%}.pt .acts{margin-left:0;width:100%}.pt .acts form{flex:1}.pt .acts button{width:100%}
thead{display:none}table,tbody,tr,td{display:block}
tr{padding:10px 16px;border-bottom:1px solid var(--line2)}tbody tr:last-child{border-bottom:0}
td{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border:0;text-align:right}
td::before{content:attr(data-l);color:var(--muted);font-size:12.5px;text-align:left;flex:none}td .v{text-align:right}
td:first-child{display:block;padding-bottom:6px}td:first-child .v{text-align:left}td:first-child::before{content:none}
td small{text-align:right}td:first-child small{text-align:left}td.n{white-space:normal}td:empty,td.wide{display:none}
.cap tbody tr:nth-child(n+4){display:none}td.act{display:flex;gap:8px}td.act .v{display:flex;gap:8px;width:100%}td.act form{flex:1}.reco dl{grid-template-columns:1fr}.reco dt{padding-top:4px}.amt{margin-left:0;width:100%}
.ticks.d30 span{font-size:10px}td.act::before{content:none}td.act button{width:100%;margin-top:6px}tbody tr:hover td{background:none}.facts{grid-template-columns:1fr;gap:0 0}.facts dd{margin-bottom:6px}}
@media (pointer:coarse){button,.btn{min-height:44px}.jump a{min-height:44px}.reco summary{min-height:44px;display:flex;align-items:center}}`;