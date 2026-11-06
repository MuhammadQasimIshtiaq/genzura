/* Gupzy story music — copyright-free only.
   Songs come from Openverse (https://openverse.org): music under Creative Commons licences that allow commercial use
   (CC0, CC BY, CC BY-SA …). Popular commercial songs are NOT offered here on purpose (copyright).
   The person can also pick a song from their own phone.
   API:  GzMusic.pick(function(track){...})   track = {title, artist, url, cover, license, link}  or {file, title, artist:'From my phone'}
         GzMusic.play(url,{loop:true}) / GzMusic.pause() / GzMusic.resume() / GzMusic.stop()
         GzMusic.safe(url, allowBlob)  -> true if the url may be played */
(function(){
  var A = new Audio(); A.preload = 'auto';
  var prev = new Audio(), prevKey = null;
  var built = false, onPick = null, searchTok = 0;

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function safe(u, blobOk){ return typeof u === 'string' && (/^https:\/\//.test(u) || (blobOk && /^blob:/.test(u))); }

  var CSS = '#gzm{position:fixed;inset:0;z-index:99990;background:#0b0b10;color:#fff;display:none;flex-direction:column;font-family:inherit}'
  + '#gzm.on{display:flex}'
  + '#gzm .h{display:flex;align-items:center;gap:10px;padding:calc(8px + env(safe-area-inset-top,0px)) 12px 6px;font-weight:700;font-size:17px}'
  + '#gzm .h button{border:0;background:none;color:#fff;font-size:20px;width:40px;height:40px}'
  + '#gzm .s{display:flex;gap:8px;padding:6px 12px}'
  + '#gzm .s input{flex:1;min-width:0;border:0;border-radius:20px;background:#ffffff22;color:#fff;padding:11px 16px;font-size:15px;outline:0}'
  + '#gzm .s input::placeholder{color:#fff9}'
  + '#gzm .go{border:0;border-radius:20px;background:#0866ff;color:#fff;font-weight:700;padding:0 18px;font-size:14px}'
  + '#gzm .c{display:flex;gap:8px;flex-wrap:wrap;padding:4px 12px 8px}'
  + '#gzm .c span{background:#ffffff1f;border-radius:16px;padding:7px 13px;font-size:13px}'
  + '#gzm .ph{margin:0 12px 6px;border:0;border-radius:20px;background:#ffffff22;color:#fff;font-weight:700;font-size:14px;padding:11px 16px;text-align:left}'
  + '#gzm .note{padding:0 14px 6px;font-size:12px;color:#fff9}'
  + '#gzm .l{flex:1;overflow:auto;padding:0 8px 16px}'
  + '#gzm .r{display:flex;align-items:center;gap:12px;padding:8px 6px;border-radius:10px}'
  + '#gzm .r img,#gzm .r .cv{width:46px;height:46px;border-radius:8px;background:#ffffff22;flex:none;object-fit:cover}'
  + '#gzm .r .t{flex:1;min-width:0}'
  + '#gzm .r .t b{display:block;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  + '#gzm .r .t i{display:block;font-style:normal;font-size:12px;color:#fffb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  + '#gzm .r button{border:0;border-radius:16px;padding:8px 13px;font-weight:700;font-size:13px}'
  + '#gzm .r .pl{background:#ffffff22;color:#fff}'
  + '#gzm .r .use{background:#0866ff;color:#fff}'
  + '#gzm .m{padding:18px;text-align:center;color:#fffb;font-size:14px}';

  function build(){
    if(built) return; built = true;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var d = document.createElement('div'); d.id = 'gzm';
    d.innerHTML = '<div class="h"><button id="gzmX" aria-label="Close">✕</button><div>Music</div></div>'
      + '<div class="s"><input id="gzmQ" type="search" placeholder="Search copyright-free music…" autocomplete="off"><button class="go" id="gzmGo">Search</button></div>'
      + '<div class="c" id="gzmC"><span>Chill</span><span>Lo-fi</span><span>Happy</span><span>Sad</span><span>Piano</span><span>Acoustic</span><span>Hip hop</span><span>Electronic</span><span>Cinematic</span><span>Ambient</span><span>Rock</span><span>Jazz</span></div>'
      + '<button class="ph" id="gzmPh">📁 Pick a song from my phone</button>'
      + '<div class="note">These songs are free to use (Creative Commons). Use only music you own or may use.</div>'
      + '<div class="l" id="gzmL"><div class="m">Loading music…</div></div>'
      + '<input type="file" id="gzmF" accept="audio/*" style="display:none">';
    document.body.appendChild(d);
    document.getElementById('gzmX').onclick = close;
    document.getElementById('gzmGo').onclick = function(){ search(document.getElementById('gzmQ').value); };
    document.getElementById('gzmQ').addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); search(this.value); this.blur(); } });
    document.getElementById('gzmC').addEventListener('click', function(e){ var s = e.target.closest('span'); if(!s) return; document.getElementById('gzmQ').value = s.textContent; search(s.textContent); });
    document.getElementById('gzmPh').onclick = function(){ var f = document.getElementById('gzmF'); f.value = ''; f.click(); };
    document.getElementById('gzmF').onchange = function(){
      var f = this.files && this.files[0]; if(!f) return;
      if(f.size > 15 * 1048576){ alert('Song is too big (max 15 MB)'); return; }
      var nm = (f.name || 'My song').replace(/\.[a-z0-9]+$/i, '').slice(0, 60);
      var cb = onPick; close(); if(cb) cb({ title: nm, artist: 'From my phone', url: null, cover: '', file: f });
    };
  }

  function close(){ try{ prev.pause(); }catch(e){} prevKey = null; var d = document.getElementById('gzm'); if(d) d.classList.remove('on'); }

  function licLabel(r){
    var l = String(r.license || '').toUpperCase(); if(!l) return '';
    if(l === 'CC0' || l === 'PDM') return l;
    return 'CC ' + l + (r.license_version ? ' ' + r.license_version : '');
  }

  function search(q){
    q = (q || '').trim(); if(!q) return;
    var L = document.getElementById('gzmL'), tok = ++searchTok;
    L.innerHTML = '<div class="m">Searching…</div>';
    var url = 'https://api.openverse.org/v1/audio/?q=' + encodeURIComponent(q) + '&license_type=commercial&category=music&page_size=30';
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var to = setTimeout(function(){ if(ctl) ctl.abort(); }, 10000);
    fetch(url, ctl ? { signal: ctl.signal } : {}).then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function(d){
      clearTimeout(to); if(tok !== searchTok) return;
      var res = (d && d.results || []).filter(function(x){ return x && x.url && /^https:\/\//.test(x.url); });
      if(!res.length){ L.innerHTML = '<div class="m">No music found. Try another word.</div>'; return; }
      L.innerHTML = res.map(function(x, k){
        var th = x.thumbnail && /^https:\/\//.test(x.thumbnail) ? '<img src="' + esc(x.thumbnail) + '" alt="" loading="lazy">' : '<div class="cv"></div>';
        return '<div class="r" data-k="' + k + '">' + th + '<div class="t"><b>' + esc(x.title || 'Untitled') + '</b><i>' + esc(x.creator || 'Unknown') + ' · ' + esc(licLabel(x)) + '</i></div><button class="pl">▶</button><button class="use">Use</button></div>';
      }).join('');
      L.querySelectorAll('.r').forEach(function(row){
        var x = res[+row.getAttribute('data-k')];
        row.querySelector('.pl').onclick = function(){
          var btns = L.querySelectorAll('.pl'); for(var i = 0; i < btns.length; i++) btns[i].textContent = '▶';
          if(prevKey === x.id && !prev.paused){ prev.pause(); prevKey = null; return; }
          prevKey = x.id; prev.src = x.url; var p = prev.play(); if(p && p.catch) p.catch(function(){}); this.textContent = '❚❚';
        };
        row.querySelector('.use').onclick = function(){
          var cb = onPick; close();
          if(cb) cb({ title: String(x.title || 'Music').slice(0, 80), artist: String(x.creator || '').slice(0, 60), url: x.url, cover: (x.thumbnail && /^https:\/\//.test(x.thumbnail)) ? x.thumbnail : '', license: licLabel(x), link: x.foreign_landing_url || '' });
        };
      });
    }).catch(function(e){
      clearTimeout(to); if(tok !== searchTok) return;
      L.innerHTML = '<div class="m">Could not reach the music library. Check your internet, or pick a song from your phone.</div>';
    });
  }

  window.GzMusic = {
    safe: safe,
    pick: function(cb){
      build(); onPick = cb; document.getElementById('gzm').classList.add('on');
      var L = document.getElementById('gzmL');
      if(!L.querySelector('.r')){ document.getElementById('gzmQ').value = 'Chill'; search('Chill'); }
    },
    play: function(url, o){ try{ A.pause(); A.src = url; A.loop = !(o && o.loop === false); try{ A.currentTime = 0; }catch(e){} var p = A.play(); if(p && p.catch) p.catch(function(){}); }catch(e){} },
    pause: function(){ try{ A.pause(); }catch(e){} },
    resume: function(){ try{ if(A.src){ var p = A.play(); if(p && p.catch) p.catch(function(){}); } }catch(e){} },
    stop: function(){ try{ A.pause(); A.removeAttribute('src'); A.load(); }catch(e){} }
  };
})();
