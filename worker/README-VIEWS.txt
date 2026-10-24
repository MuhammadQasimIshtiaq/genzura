GENZURA - Country-wise revenue: setup (sirf ek baar)
=========================================================

Kya badla hai
-------------
1. Admin Panel mein naya "Revenue" tab: yahan AdMob (App) aur Adsterra/HilltopAds/ExoClick (Web) ki
   country-wise revenue daalte hain. Same country do networks se aaye to amount khud jama ho jata hai.
   Jo countries list mein nahi, unka total "Other" mein. Month selector bhi hai (pichle 12 mahine).
2. Payout: har (App/Web + country) ka apna pool hai, aur wo sirf usi country ke views mein baanta jata hai.
   - Jis country ka revenue row nahi, uske views "Other" pool mein jate hain.
   - Purane views (jin mein country nahi) bhi "Other" mein jate hain.
   - VPN / proxy wale views bhi "Other" mein jate hain (US/UK ke pool se paisa nahi milta).
   - Purane mahine jahan sirf App/Web total tha, wo pehle jaisa hi hisaab dete hain.
3. Genzura Studio > Earn: naya "Views by country" card (creator ko apne views ki country dikhti hai).
4. Admin > Creators > kisi creator par tap: views by country + gross kaise bana, dono dikhte hain.

VPN ka ilaaj (har view par server check karta hai, koi ek signal mila to view vpn:true)
-----------------------------------------------------------------------------------
- Country phone se nahi, Cloudflare se aati hai (asli IP se), isliye user "US" likh kar fraud nahi kar sakta.
- Tor, datacenter/hosting/VPN companies ke IP (ASN list), optional IP-reputation lookup,
  Android app mein VPN ON, aur phone ka timezone IP wali country se na milna.
- Phone se aane wale hints sirf view ko SAKHT bana sakte hain, narm nahi.
- Limit: koi "residential VPN" use kare aur phone ka timezone bhi US kar le to ye pakda nahi jayega.
  100% proof koi system nahi deta. PROXYCHECK_KEY / VPNAPI_KEY lagane se detection behtar hoti hai.

SETUP
-----
A) Cloudflare par naya Worker banayein (naam e.g. arain-views):
   Workers & Pages > Create > Worker > code mein worker/views-worker.js ka poora code paste karein > Deploy.

B) Us Worker ke Settings > Variables and Secrets mein ye 3 daalein (push wale Worker jaisi hi values):
      FIREBASE_PROJECT_ID
      FIREBASE_CLIENT_EMAIL
      FIREBASE_PRIVATE_KEY
   Optional (behtar VPN detection): PROXYCHECK_KEY  ya  VPNAPI_KEY  (dono ki free key milti hai)

C) Worker ka link copy karein (e.g. https://arain-views.NAME.workers.dev) aur index.html mein
   AT_VIEWS_BASE ke saamne daalein:
      const AT_VIEWS_BASE = 'https://arain-views.NAME.workers.dev';
   Jab tak ye khali hai, app purane tareeqe se views save karti hai (bina country ke), kuch toot'ta nahi.

D) Firestore Rules (ZAROORI, warna koi phone se khud "US" likh kar view save kar sakta hai):
   Apni rules mein "views" wala match aise kar dein, baaki rules na chhedein:

      match /views/{viewId} {
        allow read: if request.auth != null;
        allow write: if false;     // views sirf Worker (service account) likhta hai
      }

   Dhyan: C ke baad hi D karein. Pehle D kar diya to Worker ke bina views save nahi honge.

E) Site deploy karein (Netlify). Android app ko dobara build karein (MainActivity.kt mein isVpnActive() add hua hai).
   Genzura Studio ke Android app mein kuch badalna nahi hai.

Mahine ka kaam
--------------
Admin Panel > Revenue: mahina chunein > App aur Web ke liye country-wise amounts daalein > Save revenue.
Neeche "Views by country" table dikhati hai kin countries ke views aaye aur kis ka apna pool hai
(jis country ke saamne peela "Other" hai, uska revenue row abhi nahi daala).
