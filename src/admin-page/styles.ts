export const CSS = `
:root{color-scheme:light dark;--bg:#f4f5f7;--panel:#fff;--side:#ebedf1;--line:#dfe2e7;--line2:#eceef2;--hover:#f6f7f9;--text:#15171b;--muted:#585e6a;
--accent:#2a4fd6;--ok:#11744a;--warn:#875200;--bad:#b42318;--bar:#9aa3b2;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0d0f12;--panel:#15181c;--side:#101216;--line:#262a31;--line2:#1d2026;--hover:#1a1d22;--text:#e7e9ed;
--muted:#9ba2ae;--accent:#86a0ff;--ok:#4fcf8a;--warn:#efb558;--bad:#ff8a7c;--bar:#4a5260}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-padding-top:16px}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
::selection{background:color-mix(in srgb,var(--accent) 28%,transparent)}
a{color:inherit;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.ok{--lvl:var(--ok)}.warn{--lvl:var(--warn)}.bad{--lvl:var(--bad)}
code,.mono{font-family:var(--mono);font-size:12.5px}
.mark{display:inline-flex;flex:none;color:var(--lvl)}.mark svg{width:16px;height:16px;overflow:visible}
.mark .s{fill:currentColor}.mark .g{fill:none;stroke:var(--panel);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.shell{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:var(--side);border-right:1px solid var(--line);padding:16px 12px}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 16px;font-weight:650;font-size:15px}
.brand svg{width:22px;height:22px;color:var(--accent)}.brand small{color:var(--muted);font-weight:500;font-size:12px}
.nav{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.nav a{display:flex;align-items:center;gap:10px;min-height:34px;padding:0 10px;border-radius:8px;text-decoration:none;color:var(--muted);font-weight:500}
.nav a:hover{background:color-mix(in srgb,var(--text) 6%,transparent);color:var(--text)}
.nav a .mark svg{width:14px;height:14px}.nav a.cur{background:var(--panel);color:var(--text);box-shadow:0 1px 2px rgb(0 0 0/.06)}
.nav .n{margin-left:auto;font-size:12px;font-variant-numeric:tabular-nums;color:var(--muted)}
.foot{margin-top:auto;padding:12px 8px 0;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
.foot b{color:var(--text);font-weight:600}.foot form{margin-top:8px}
.main{min-width:0;padding:24px 32px 64px;max-width:1480px}
.top{display:flex;align-items:flex-start;gap:14px;margin-bottom:20px}
.top .mark svg{width:28px;height:28px}.top .mark .g{stroke-width:2.2}
h1{font-size:22px;line-height:1.2;margin:0;letter-spacing:-.01em}
.top p{margin:4px 0 0;color:var(--muted);font-size:13px}
.msg{display:flex;gap:8px;align-items:center;padding:10px 14px;border-radius:8px;background:var(--panel);border:1px solid var(--line);margin:0 0 16px}
.attn{list-style:none;margin:0 0 20px;padding:0;border:1px solid var(--line);border-radius:10px;background:var(--panel);overflow:hidden}
.attn li{display:flex;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--line2)}.attn li:first-child{border-top:0}
.attn a{font-weight:600}.attn span.t{color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:24px;overflow:hidden}
.kpis.few{grid-template-columns:repeat(3,minmax(0,1fr))}
.scope{margin:-8px 0 20px;padding:10px 14px;border-radius:8px;background:color-mix(in srgb,var(--accent) 9%,var(--panel));border:1px solid color-mix(in srgb,var(--accent) 30%,var(--line))}
.scope small{display:block;color:var(--muted);font-size:12.5px;margin-top:2px}
.kpi{display:flex;flex-direction:column;gap:2px;padding:14px 16px;text-decoration:none;border-left:1px solid var(--line2);min-width:0}
.kpi:first-child{border-left:0}.kpi:hover{background:var(--hover)}
.kpi .kl{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12.5px;font-weight:500}
.kpi b{font-size:22px;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi small{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:20px;scroll-margin-top:16px;overflow:hidden}
.sh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}
h2{font-size:15px;font-weight:650;margin:0}
.sh .meta{color:var(--muted);font-size:12.5px}.sh .acts{margin-left:auto;display:flex;gap:8px}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;line-height:20px;padding:0 8px 0 6px;border-radius:999px;white-space:nowrap;
color:var(--lvl);background:color-mix(in srgb,var(--lvl) 12%,transparent)}
.pill .mark svg{width:13px;height:13px}.pill .mark .g{stroke:color-mix(in srgb,var(--lvl) 12%,var(--panel))}
.sub{padding:12px 16px 4px;margin:0;font-size:12.5px;font-weight:600;color:var(--muted)}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font-size:12px;font-weight:600;color:var(--muted);padding:8px 16px;border-bottom:1px solid var(--line);white-space:nowrap;background:color-mix(in srgb,var(--side) 45%,var(--panel))}
td{padding:9px 16px;border-bottom:1px solid var(--line2);vertical-align:top}
tbody tr:last-child td{border-bottom:0}tbody tr:hover td{background:var(--hover)}
th.n,td.n{text-align:right;white-space:nowrap}
td small{display:block;color:var(--muted);font-size:12.5px;margin-top:1px}td .v{min-width:0}
td b{font-weight:600}td .err{color:var(--bad)}
.use{display:block;width:96px;height:4px;margin:5px 0 0 auto;border-radius:2px}.use .t{fill:var(--line)}.use .f{fill:var(--lvl,var(--accent))}
.empty{padding:16px;color:var(--muted);margin:0}
.stats{display:flex;flex-wrap:wrap;gap:8px 32px;padding:12px 16px;border-bottom:1px solid var(--line2)}
.stats div{display:flex;flex-direction:column}.stats span{color:var(--muted);font-size:12.5px}.stats b{font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}
.chart{padding:14px 16px 6px;border-bottom:1px solid var(--line2)}
.chart svg{display:block;width:100%;height:120px}.chart .bs{fill:var(--bar)}.chart .bf{fill:var(--bad)}.chart .hit{fill:transparent}
.chart g:hover .bs{fill:var(--muted)}.chart .gl{stroke:var(--line)}
.cmax{text-align:right;color:var(--muted);font-size:12px;margin-bottom:4px;font-variant-numeric:tabular-nums}
.ticks{display:grid;grid-template-columns:repeat(24,1fr);color:var(--muted);font-size:11px;margin-top:4px;font-variant-numeric:tabular-nums}.ticks span{white-space:nowrap}.legend{display:flex;gap:16px;color:var(--muted);font-size:12px;margin-top:6px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}.legend .ls{background:var(--bar)}.legend .lf{background:var(--bad)}
.filter{padding:10px 16px;margin:0;border-bottom:1px solid var(--line2);color:var(--muted)}
button{min-height:32px;padding:0 12px;border-radius:7px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit;font-weight:600;font-size:13px;cursor:pointer}
button:hover{background:var(--hover);border-color:color-mix(in srgb,var(--muted) 50%,var(--line))}button:active{transform:translateY(1px)}
.danger{color:var(--bad)}
.foot button{width:100%}
.login{max-width:400px;margin:12vh auto;padding:0 16px}.login .brand{padding:0 0 20px}
.login section{padding:20px}.login p{color:var(--muted)}
.login label{display:block;font-weight:600;margin-bottom:6px}
input[type=password]{width:100%;min-height:44px;padding:0 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
.login button{width:100%;min-height:44px;margin-top:14px;background:var(--text);color:var(--panel);border-color:var(--text)}
@media (max-width:1180px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.kpi:nth-child(4){border-left:0}.kpi:nth-child(n+4){border-top:1px solid var(--line2)}}
@media (max-width:900px){.shell{display:block}
.side{position:sticky;z-index:2;height:auto;overflow:hidden;flex-direction:row;flex-wrap:wrap;align-items:center;padding:8px 16px 0;border-right:0;border-bottom:1px solid var(--line)}
.brand{padding:4px 0;flex:1}.foot{order:2;margin:0;padding:0;border:0;display:flex;align-items:center;gap:10px}.foot .who{display:none}.foot form{margin:0}
.nav{order:3;flex-basis:100%;min-width:0;flex-direction:row;overflow-x:auto;gap:4px;margin:6px -16px 0;padding:0 16px 8px;scrollbar-width:none}
.nav a{white-space:nowrap;min-height:40px;padding:0 12px;border:1px solid var(--line);background:var(--panel)}.nav .n{margin-left:2px}
.main{padding:16px 16px 48px}section,#visao{scroll-margin-top:132px}}
@media (max-width:640px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi{border-left:1px solid var(--line2)!important;border-top:1px solid var(--line2)}
.kpi:nth-child(odd){border-left:0!important}.kpi:nth-child(-n+2){border-top:0}.kpi b{font-size:19px}
h1{font-size:19px}.sh .acts{margin-left:0;width:100%}.sh .acts button{width:100%}
thead{display:none}table,tbody,tr,td{display:block}
tr{padding:10px 16px;border-bottom:1px solid var(--line2)}tbody tr:last-child{border-bottom:0}
td{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border:0;text-align:right}
td::before{content:attr(data-l);color:var(--muted);font-size:12.5px;text-align:left;flex:none}td .v{text-align:right}
td:first-child{display:block;padding-bottom:6px}td:first-child .v{text-align:left}td:first-child::before{content:none}
td small{text-align:right}td:first-child small{text-align:left}td.n{white-space:normal}td:empty{display:none}
td.act{display:block}td.act::before{content:none}td.act button{width:100%;margin-top:6px}tbody tr:hover td{background:none}}
@media (pointer:coarse){button{min-height:44px}.nav a{min-height:44px}}`;
