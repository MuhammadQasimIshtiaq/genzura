/* Gupzy weave splash
   4 neon threads shoot in from the screen corners, weave together in the middle, then a glow burst
   and the logo pops up.  Used by: web (index.html), Gupchats, Studio (and so the Android apps).
   Usage:  GzWeave('bootLoading')  or  GzWeave(element, {colors:[...]})
   The logo pop itself is done with CSS (see .gzw-logo) so it always shows even if this file fails to load. */
(function(){
  var T_FLY = 0.55, T_WEAVE = 0.85, T_BURST = 0.85, T_END = 1.8;   /* seconds; burst time must match the CSS pop delay */

  window.GzWeave = function(target, opt){
    /* tell the Android app the web animation has started: its dark cover fades away and the weave is revealed */
    try{ if(window.AndroidAuth && AndroidAuth.bootDone) AndroidAuth.bootDone(); }catch(e){}
    try{ if(window.AndroidStudio && AndroidStudio.bootDone) AndroidStudio.bootDone(); }catch(e){}
    try{
      var host = typeof target === 'string' ? document.getElementById(target) : target;
      if(!host) return;
      if(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      opt = opt || {};
      var colors = opt.colors || ['#ff2bd6', '#00e5ff', '#8a3bff', '#39ff88'];
      var cv = document.createElement('canvas');
      cv.className = 'gzw-canvas';
      cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:0';
      host.insertBefore(cv, host.firstChild);
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      var W = host.clientWidth || innerWidth, H = host.clientHeight || innerHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      var g = cv.getContext('2d'); g.scale(dpr, dpr);
      var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.2;

      /* corner starts (a little outside the screen), each with its own curve */
      var starts = [[-0.06 * W, -0.06 * H], [1.06 * W, -0.06 * H], [1.06 * W, 1.06 * H], [-0.06 * W, 1.06 * H]];
      var threads = starts.map(function(s, i){
        return { sx: s[0], sy: s[1], col: colors[i % colors.length], ph: i * Math.PI / 2, pts: [], bend: (i % 2 ? 1 : -1) * 0.22 };
      });
      var sparks = [];
      /* pre-drawn glow dots (no shadowBlur in the loop = smooth on phones) */
      var glow = {};
      function sprite(col){
        var s = document.createElement('canvas'); s.width = s.height = 48; var c = s.getContext('2d');
        var gr = c.createRadialGradient(24, 24, 0, 24, 24, 24);
        gr.addColorStop(0, '#fff'); gr.addColorStop(0.25, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = gr; c.fillRect(0, 0, 48, 48); return s;
      }
      colors.forEach(function(c){ glow[c] = sprite(c); });
      var t0 = performance.now(), burst = false, raf;

      function ease(x){ return x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x); }

      function pos(th, t){
        if(t <= T_FLY){                                   /* fly in along a curve */
          var u = ease(t / T_FLY);
          var x = th.sx + (cx - th.sx) * u, y = th.sy + (cy - th.sy) * u;
          var dx = cx - th.sx, dy = cy - th.sy, len = Math.hypot(dx, dy) || 1;
          var k = Math.sin(u * Math.PI) * th.bend * len;   /* sideways bow */
          return [x + (-dy / len) * k, y + (dx / len) * k];
        }
        var w = Math.min((t - T_FLY) / (T_WEAVE - T_FLY), 1);   /* weave: lissajous braid that tightens */
        var a = th.ph + w * Math.PI * 3.2;
        var r = R * (1 - 0.55 * w) * (0.35 + 0.65 * Math.min(w * 3, 1));
        return [cx + Math.cos(a) * r, cy + Math.sin(a * 2 + th.ph) * r * 0.62];
      }

      function doBurst(){
        burst = true;
        for(var i = 0; i < 34; i++){
          var a = Math.random() * Math.PI * 2, sp = 90 + Math.random() * 260;
          sparks.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, c: colors[i % colors.length], l: 0.5 + Math.random() * 0.4 });
        }
      }

      function frame(now){
        var t = (now - t0) / 1000;
        g.clearRect(0, 0, W, H);
        g.globalCompositeOperation = 'source-over';

        if(t < T_BURST + 0.12){
          threads.forEach(function(th){
            th.pts.push(pos(th, Math.min(t, T_WEAVE)));
            if(th.pts.length > 46) th.pts.shift();
            var n = th.pts.length;
            if(n < 2) return;
            var fade = t > T_WEAVE ? Math.max(0, 1 - (t - T_WEAVE) / 0.12) : 1;
            g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = th.col;
            var P = th.pts, tail = P[0], hd = P[n - 1];
            function trace(){                               /* one smooth curve through the points */
              g.beginPath(); g.moveTo(P[0][0], P[0][1]);
              for(var i = 1; i < n - 1; i += 2){
                var m = P[Math.min(i + 1, n - 1)];
                g.quadraticCurveTo(P[i][0], P[i][1], (P[i][0] + m[0]) / 2, (P[i][1] + m[1]) / 2);
              }
              g.lineTo(hd[0], hd[1]);
            }
            var lg = g.createLinearGradient(tail[0], tail[1], hd[0], hd[1]);
            lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(1, '#fff');
            var cg = g.createLinearGradient(tail[0], tail[1], hd[0], hd[1]);
            cg.addColorStop(0, 'rgba(0,0,0,0)'); cg.addColorStop(1, th.col);
            trace(); g.strokeStyle = cg; g.globalAlpha = 0.45 * fade; g.lineWidth = 9; g.stroke();   /* soft glow */
            trace(); g.strokeStyle = lg; g.globalAlpha = 0.95 * fade; g.lineWidth = 2; g.stroke();   /* bright core */
            var h = th.pts[n - 1];                           /* bright head */
            g.globalAlpha = fade; g.drawImage(glow[th.col], h[0] - 18, h[1] - 18, 36, 36);
          });
          g.globalAlpha = 1;
        }

        if(t >= T_BURST && !burst) doBurst();
        if(burst){
          var b = t - T_BURST;
          /* soft glow flash */
          var fl = Math.max(0, 1 - b / 0.55);
          if(fl > 0){
            var rad = R * (1.2 + b * 7);
            var gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
            gr.addColorStop(0, 'rgba(255,255,255,' + (0.9 * fl) + ')');
            gr.addColorStop(0.35, 'rgba(138,59,255,' + (0.45 * fl) + ')');
            gr.addColorStop(1, 'rgba(0,229,255,0)');
            g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, rad, 0, 7); g.fill();
          }
          /* shock ring */
          var rg = Math.max(0, 1 - b / 0.6);
          if(rg > 0){
            g.strokeStyle = 'rgba(255,255,255,' + (0.7 * rg) + ')'; g.lineWidth = 2.5 * rg + 0.5;
            g.beginPath(); g.arc(cx, cy, R * 0.6 + b * Math.min(W, H) * 0.95, 0, 7); g.stroke();
          }
          /* sparks */
          sparks.forEach(function(s){
            var life = 1 - b / s.l; if(life <= 0) return;
            var x = s.x + s.vx * b, y = s.y + s.vy * b;
            g.globalAlpha = life; var z = 14 * life + 4; g.drawImage(glow[s.c], x - z / 2, y - z / 2, z, z);
          });
          g.globalAlpha = 1;
        }

        if(t < T_END && document.body.contains(cv)) raf = requestAnimationFrame(frame);
        else { g.clearRect(0, 0, W, H); cv.style.display = 'none'; }
      }
      raf = requestAnimationFrame(frame);
    }catch(e){}
  };
})();
