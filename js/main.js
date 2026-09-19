(function(){
  var langToggle = document.getElementById('langToggle');
  var toast = document.getElementById('toast');
  var toastTimer;

  function showToast(msg){
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toast.classList.remove('show'); }, 2600);
  }

  function applyLang(lang){
    var isFa = lang === 'fa';
    document.documentElement.lang = isFa ? 'fa' : 'en';
    document.documentElement.dir = isFa ? 'rtl' : 'ltr';
    document.body.classList.toggle('fa-mode', isFa);
    document.querySelectorAll('[data-en]').forEach(function(el){
      var val = isFa ? (el.getAttribute('data-fa') || el.getAttribute('data-en')) : el.getAttribute('data-en');
      if(!val) return;
      if(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'){
        el.setAttribute('placeholder', val);
      } else {
        el.innerHTML = val;
      }
    });
    langToggle.textContent = isFa ? 'EN' : 'فا';
    try{ localStorage.setItem('pardeh-lang', lang); }catch(e){}
  }

  langToggle.addEventListener('click', function(){
    var next = document.documentElement.lang === 'fa' ? 'en' : 'fa';
    applyLang(next);
  });

  document.querySelectorAll('.ticket-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      var isFa = document.documentElement.lang === 'fa';
      showToast(isFa ? 'فروش بلیت در فاز بعدی راه‌اندازی می‌شود — به‌زودی برمی‌گردیم!' : 'Ticketing launches in the next phase — check back soon!');
    });
  });

  var saved = 'en';
  try{ saved = localStorage.getItem('pardeh-lang') || 'en'; }catch(e){}
  applyLang(saved);
})();
