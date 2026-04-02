require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// Konuşma takibi — her numara için ilk mesaj mı kontrol eder (24 saat sıfırlanır)
const konusmaBellegi = new Map();
function ilkMesajMi(sender) {
    const simdi = Date.now();
    const son = konusmaBellegi.get(sender);
    if (!son || simdi - son > 86400000) {
        konusmaBellegi.set(sender, simdi);
        return true;
    }
    konusmaBellegi.set(sender, simdi);
    return false;
}
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
    console.log(`\n[${new Date().toLocaleTimeString()}] SİSTEME İSTEK GELDİ: ${req.method} ${req.path}`);
    if (req.method === 'POST') console.log('GELEN VERİ:', req.body);
    next();
});

app.get('/webhook', (req, res) => res.status(200).send("Webhook aktif ve calisiyor"));

app.get('/modeller', async (req, res) => {
    try {
        const r = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        const destekli = r.data.models
            .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace('models/', ''));
        res.json({ modeller: destekli });
    } catch(e) { res.json({ hata: e.message }); }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const FONNTE_TOKEN = process.env.FONNTE_TOKEN;
const SID = '1IeQ3BUb4BBmXETJ_wZ0agT1DW9LpYhtc3kR-9hDNY8M';
const IID = '1aHKb7lv6sei2ExnIB5Li0pEtygRo3hWLxTJGiHbda0g';

const URLS = {
    cariler:        `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=1423089940`,
    urunler:        `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=1263788777`,
    siparisler:     `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=748556980`,
    acikSiparisler: `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=1995109523`,
    eksikJant:      `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=1586553902`,
    makinalar:      `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=1621316106`,
    polyfill:       `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=174636469`,
    teknikBilgi:    `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=1461616374`,
    islemler:       `https://docs.google.com/spreadsheets/d/${IID}/export?format=csv&gid=1884664027`,
    bakiye:         `https://docs.google.com/spreadsheets/d/${IID}/export?format=csv&gid=754315254`,
};

function parseCSV(text) {
    const lines = text.split('\n');
    if (!lines.length) return [];
    const headers = splitRow(lines[0]).map(h => h.trim().replace(/\r/g, ''));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const vals = splitRow(line);
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = (vals[idx] || '').trim().replace(/\r/g, ''); });
        rows.push(obj);
    }
    return rows;
}

function splitRow(line) {
    const result = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQ = !inQ; continue; }
        if (c === ',' && !inQ) { result.push(cur); cur = ''; continue; }
        cur += c;
    }
    result.push(cur);
    return result;
}

async function fetchAllData() {
    const results = await Promise.allSettled(
        Object.entries(URLS).map(([key, url]) =>
            axios.get(url).then(r => ({ key, data: parseCSV(r.data) }))
        )
    );
    const data = {};
    results.forEach(r => {
        if (r.status === 'fulfilled') data[r.value.key] = r.value.data;
    });
    return data;
}

function cleanPhone(phone) {
    if (!phone) return '';
    let p = String(phone).replace(/[^0-9]/g, '');
    if (p.length > 12) p = p.slice(-12);
    if (p.startsWith('0')) p = '90' + p.substring(1);
    if (!p.startsWith('90')) p = '90' + p;
    return p;
}

function normalizeOlcu(str) {
    if (!str) return '';
    return String(str).replace(/[xX\/\-\s]/g, '.').replace(/,/g, '.').trim().toLowerCase();
}

function polyfillAra(polyfillData, aranan) {
    const norm = normalizeOlcu(aranan);
    if (!norm) return [];
    let bulunan = (polyfillData || []).filter(r => {
        const lastik = normalizeOlcu(r['Lastik Ölçüsü'] || r['Lastik Olcusu'] || '');
        const jant   = normalizeOlcu(r['Jant Ölçüsü']  || r['Jant Olcusu']  || '');
        return lastik === norm || jant === norm;
    });
    if (!bulunan.length) {
        bulunan = (polyfillData || []).filter(r => {
            const lastik = normalizeOlcu(r['Lastik Ölçüsü'] || r['Lastik Olcusu'] || '');
            const jant   = normalizeOlcu(r['Jant Ölçüsü']  || r['Jant Olcusu']  || '');
            return lastik.includes(norm) || norm.includes(lastik) ||
                   jant.includes(norm)   || norm.includes(jant);
        });
    }
    return bulunan;
}

// ═══════════════════════════════════════════════════════════════
// TEKNİK BİLGİ AKILLI ARAMA FONKSİYONU
// Mesajdaki anahtar kelimelere göre ilgili teknik bilgileri filtreler
// ═══════════════════════════════════════════════════════════════
function teknikBilgiAra(teknikData, mesaj) {
    if (!teknikData || !teknikData.length) return { filtrelenmis: '', toplamSatir: 0 };

    const msg = mesaj.toUpperCase().replace(/[_\-\.]/g, ' ');

    // Mesajdan anahtar kelimeleri çıkar
    const anahtarlar = [];

    // Marka tespiti
    const markalar = ['ELS LIFT', 'ELS', 'DINGLI', 'JCPT', 'GENIE', 'JLG', 'HAULOTTE', 'SKYJACK', 'SINOBOOM', 'LGMG', 'ZOOMLION', 'MANITOU'];
    markalar.forEach(m => { if (msg.includes(m)) anahtarlar.push(m); });

    // Model tespiti (EL 12, EL12, JCPT1412DC vb.)
    const modelRegex = /\b(EL\s*\d+[\-]?[A-Z]*|JCPT\s*\d+\s*[A-Z]*)\b/gi;
    const modelBulundu = mesaj.match(modelRegex);
    if (modelBulundu) modelBulundu.forEach(m => anahtarlar.push(m.replace(/\s+/g, ' ').trim().toUpperCase()));

    // Hata kodu tespiti
    const hataRegex = /\b(hata|arıza|error|fault|kod|code)\b/gi;
    const hataKoduRegex = /\b(0[1-9]|[1-9][0-9]|OL|LL)\b/g;
    if (hataRegex.test(mesaj)) {
        anahtarlar.push('Hata Kodu');
        const kodlar = mesaj.match(hataKoduRegex);
        if (kodlar) kodlar.forEach(k => anahtarlar.push(`Hata Kodu ${k}`));
    }

    // Teknik konu tespiti
    const konuAnahtarlari = {
        'bakım': ['Bakım', 'Periyodik'],
        'bakim': ['Bakım', 'Periyodik'],
        'maintenance': ['Bakım', 'Periyodik'],
        'akü': ['Akü', 'Şarj', 'Batarya'],
        'aku': ['Akü', 'Şarj', 'Batarya'],
        'şarj': ['Şarj', 'Akü'],
        'sarj': ['Şarj', 'Akü'],
        'battery': ['Akü', 'Şarj'],
        'hidrolik': ['Hidrolik'],
        'yağ': ['Yağ', 'Hidrolik'],
        'yag': ['Yağ', 'Hidrolik'],
        'lastik': ['Lastik', 'Tekerlek'],
        'tekerlek': ['Tekerlek', 'Lastik'],
        'fren': ['Fren', 'Brake'],
        'brake': ['Fren', 'Brake'],
        'güvenlik': ['Güvenlik'],
        'guvenlik': ['Güvenlik'],
        'safety': ['Güvenlik'],
        'eğim': ['Eğim', 'Eğim Oranı'],
        'egim': ['Eğim', 'Eğim Oranı'],
        'slope': ['Eğim'],
        'kapasite': ['Kapasitesi', 'Yük'],
        'capacity': ['Kapasitesi', 'Yük'],
        'yükseklik': ['Yüksekliği', 'Yükseklik'],
        'yukseklik': ['Yüksekliği', 'Yükseklik'],
        'height': ['Yüksekliği'],
        'boyut': ['Boyut', 'Genişlik', 'Uzunluk'],
        'ölçü': ['Boyut', 'Ölçü'],
        'olcu': ['Boyut', 'Ölçü'],
        'ağırlık': ['Ağırlık'],
        'agirlik': ['Ağırlık'],
        'weight': ['Ağırlık'],
        'sürüş': ['Sürüş', 'Hız'],
        'surus': ['Sürüş', 'Hız'],
        'hız': ['Hız', 'Sürüş'],
        'hiz': ['Hız', 'Sürüş'],
        'speed': ['Hız', 'Sürüş'],
        'voltaj': ['Voltaj', 'Sistem'],
        'voltage': ['Voltaj'],
        'kumanda': ['Kumanda', 'Kontrol', 'Panel'],
        'kontrol': ['Kontrol', 'Kumanda', 'Panel'],
        'joystick': ['Kumanda', 'Kontrol'],
        'alarm': ['Alarm'],
        'acil': ['Acil', 'Emergency'],
        'emergency': ['Acil', 'Emergency'],
        'forklift': ['Forklift'],
        'nakil': ['Nakil', 'Taşıma'],
        'taşıma': ['Nakil', 'Taşıma'],
        'transport': ['Nakil', 'Taşıma'],
        'elektrik': ['Elektrik'],
        'electric': ['Elektrik'],
        'motor': ['Motor'],
        'bobin': ['Bobin', 'Coil'],
        'sensör': ['Sensör', 'Sensor'],
        'sensor': ['Sensör', 'Sensor'],
        'polyfill': ['Polyfill', 'Dolum'],
        'dolum': ['Dolum', 'Polyfill'],
    };

    const msgLower = mesaj.toLowerCase();
    Object.entries(konuAnahtarlari).forEach(([kelime, etiketler]) => {
        if (msgLower.includes(kelime)) etiketler.forEach(e => anahtarlar.push(e));
    });

    // Eğer hiç anahtar kelime bulunamadıysa, boş döndür (gereksiz veri gönderme)
    if (!anahtarlar.length) return { filtrelenmis: '', toplamSatir: 0 };

    // Teknik bilgi verisini filtrele
    const eslesen = teknikData.filter(r => {
        const konu = (r['KONU'] || '').toUpperCase();
        const aciklama = (r['AÇIKLAMA'] || r['ACIKLAMA'] || '').toUpperCase();
        const birlesik = konu + ' ' + aciklama;

        return anahtarlar.some(a => birlesik.includes(a.toUpperCase()));
    });

    // Maksimum 80 satır gönder (token limiti için)
    const sinirli = eslesen.slice(0, 80);
    const metin = sinirli.map(r => `• ${r['KONU'] || ''}: ${r['AÇIKLAMA'] || r['ACIKLAMA'] || ''}`).join('\n');

    console.log(`🔍 Teknik bilgi arama: ${anahtarlar.join(', ')} → ${eslesen.length} sonuç (${sinirli.length} gönderildi)`);

    return { filtrelenmis: metin, toplamSatir: eslesen.length };
}

// Mevcut markalar/modeller listesi (genel bilgi için)
function teknikBilgiOzet(teknikData) {
    if (!teknikData || !teknikData.length) return '';
    const markalar = new Set();
    teknikData.forEach(r => {
        const konu = r['KONU'] || '';
        // "Dingli JCPT1412DC" veya "ELS Lift EL 12" gibi marka-model çıkar
        const match = konu.match(/^(ELS Lift|Dingli|Genie|JLG|Haulotte|Skyjack|Sinoboom|LGMG|Zoomlion|Manitou)\s+(\S+)/i);
        if (match) markalar.add(`${match[1]} ${match[2]}`);
    });
    if (!markalar.size) return '';
    return 'Teknik bilgi tabanında mevcut modeller: ' + Array.from(markalar).join(', ');
}

function musteriFiltrele(data, cariAdi) {
    if (cariAdi === 'Bilinmeyen Musteri') return {};
    const cu = cariAdi.toUpperCase();
    return {
        siparisler:     (data.siparisler     || []).filter(r => (r['Cari Adı'] || r['Cari Adi'] || '').toUpperCase().includes(cu)),
        acikSiparisler: (data.acikSiparisler || []).filter(r => (r['Cari Adı'] || r['Cari Adi'] || '').toUpperCase().includes(cu)),
        eksikJant:      (data.eksikJant      || []).filter(r => (r['Cari Adı'] || r['Cari Adi'] || '').toUpperCase().includes(cu)),
        islemler:       (data.islemler       || []).filter(r => (r['Frma'] || r['Firma'] || '').toUpperCase().includes(cu)),
        bakiye:         (data.bakiye         || []).filter(r => (r['Frma'] || '').toUpperCase().includes(cu)),
    };
}

app.post('/webhook', async (req, res) => {
    res.status(200).send({ status: true });
    const sender  = req.body.sender;
    const message = req.body.message || req.body.text;
    if (!sender || !message) { console.log('Sender veya mesaj yok'); return; }

    try {
        console.log(`\n💬 ${sender} | ${message}`);
        const data = await fetchAllData();
        const senderClean = cleanPhone(sender);

        const musteri = (data.cariler || []).find(c => {
            const telefonlar = (c['TELEFON'] || '').split(',').map(t => cleanPhone(t.trim())).filter(Boolean);
            return telefonlar.includes(senderClean);
        });

        let cariAdi = 'Bilinmeyen Musteri';
        if (musteri) cariAdi = musteri['ÜNVANI 1'] || musteri['Cari Adı'] || 'Bilinmeyen Musteri';

        const mv = musteriFiltrele(data, cariAdi);
        const ilkMesaj = ilkMesajMi(sender);
        const polyfillSonuc = polyfillAra(data.polyfill, message);

        // Teknik bilgi: akıllı arama ile sadece ilgili satırları gönder
        const teknikSonuc = teknikBilgiAra(data.teknikBilgi, message);
        const teknikOzet = teknikBilgiOzet(data.teknikBilgi);

        const prompt = `Sen "Erdemli Kauçuk - Ömer Erdemli" firmasının resmi WhatsApp yapay zeka asistanısın. Adın RobERD'dir.
Sana mesaj yazan: +${sender} | Sistemdeki Cari Adı: ${cariAdi} | Bu konuşmada ilk mesaj mı: ${ilkMesaj ? 'EVET' : 'HAYIR (tanıtım ve uyarıları tekrar etme)'}

GİZLİLİK KURALI: Aşağıdaki müşteriye özel veriler YALNIZCA ${cariAdi} firmasına aittir. Başka hiçbir firmanın bilgisini paylaşma.

━━━ TEKNİK BİLGİ TABANI (Herkese verilebilir genel bilgi) ━━━
${teknikOzet}
${teknikSonuc.filtrelenmis ? `\nMesajla ilgili bulunan teknik bilgiler (${teknikSonuc.toplamSatir} sonuç):\n${teknikSonuc.filtrelenmis}` : '\n(Bu mesajla eşleşen teknik bilgi bulunamadı)'}

TEKNİK BİLGİ KULLANIM TALİMATI:
- Yukarıdaki teknik bilgiler "KONU: AÇIKLAMA" formatındadır.
- Marka ve model adı KONU alanının başında yazar (örn: "Dingli JCPT1412DC Çalışma Yüksekliği: 13.80 m").
- Hata kodları "Hata Kodu XX - Açıklama: ... Makine Davranışı: ... Çözüm: ..." formatındadır.
- Müşteri bir marka/model veya hata kodu sorduğunda, yukarıdaki bilgileri DOĞRUDAN kullanarak yanıt ver.
- Teknik bilgi varsa kesinlikle "bilmiyorum" veya "yetkiliye aktarıyorum" DEME, veriyi kullan.
- Birden fazla model karşılaştırması istenirse, her modelin bilgisini yan yana sun.

━━━ ÜRÜN FİYAT LİSTESİ ━━━
Sütunlar: Tekerlek Tanımı | kaplama (USD) | sıfır jant (USD)
Fiyat sorusunda: kaplama = müşteri kendi jantını getirdiğinde, sıfır jant = yeni jantla birlikte teslim edildiğinde.
Her zaman USD birimi ile belirt.
${JSON.stringify(data.urunler || [])}

━━━ POLYFİLL ARAMA SONUCU (Mesajdaki ölçü için) ━━━
${JSON.stringify(polyfillSonuc)}

━━━ MAKİNA - TEKERLEK REHBERİ ━━━
${JSON.stringify(data.makinalar || [])}

━━━ ${cariAdi} - SİPARİŞ GEÇMİŞİ ━━━
Sütunlar: ID | Kayıt Tarihi | Cari Adı | Üretim Modeli | İşlem Tipi | Sipariş Adeti | Jant Teslim Alma Tarihi | Jant Teslim Alma | Jant Kontrol | Teslim Etme Tarihi | Teslim Edilen | Kalan | Üretim Sayısı | Tekerlek Tanımı | Anlaşılan Fiyat | Açıklama
${JSON.stringify(mv.siparisler)}

━━━ ${cariAdi} - AÇIK / BEKLEYEN SİPARİŞLER ━━━
Sütunlar: ID | Tekerlek Tanımı | Cari Adı | Kayıt Tarihi | Jant Teslim Alma Tarihi | Üretim Sayısı | Geçen Gün Sayısı | Şehir
${JSON.stringify(mv.acikSiparisler)}

━━━ ${cariAdi} - EKSİK JANT DURUMU ━━━
Sütunlar: Cari Adı | ID | Tekerlek Tanımı | Kayıt Tarihi | Jant Kontrol | Alınacak Jant | Geçen Gün Sayısı | Şehir
${JSON.stringify(mv.eksikJant)}

━━━ ${cariAdi} - FATURA / ÖDEME İŞLEMLERİ ━━━
${JSON.stringify(mv.islemler)}

━━━ ${cariAdi} - BORÇ BAKİYE DURUMU ━━━
Sütunlar: Frma | SUM/Tutar (toplam satış) | SUM/Tahsilat (toplam ödeme) | Toplam Bakiye (net borç) | Vadeli Ciro | Vadesi Geçmiş Bakiye | Kalan Vade Gün
${JSON.stringify(mv.bakiye)}

━━━ MÜŞTERİNİN MESAJI ━━━
"${message}"

━━━ YANIT KURALLARI ━━━
1. KENDİNİ TANITMA: Sadece konuşmanın İLK mesajında "Ben RobERD, Erdemli Kauçuk'un yapay zeka asistanıyım" de. Sonraki mesajlarda asla tekrar etme.
2. KAYIT UYARISI: Sadece BİR KEZ ve yalnızca şüphe varsa "Sistemimizdeki kaydınızı şu an eşleştiremedim, detaylar için 0555 016 16 00" de. ASLA "kaydınız yok" veya "sisteme kayıtlı değilsiniz" gibi kesin ifadeler kullanma. Aynı konuşmada tekrar etme.
3. TEKNİK sorularda (hata kodu, makine özelliği, lastik ölçüsü, polyfill, makina-lastik uyumu, bakım bilgisi vb.) Teknik Bilgi Tabanını kullan. Bu bilgiler herkese verilebilir. TEKNİK BİLGİ TABANINDA CEVAP VARSA ONU KULLAN, yetkiliye aktarma.
4. MÜŞTERİYE ÖZEL sorularda (sipariş, bakiye, fiyat) YALNIZCA bu müşterinin verilerini kullan. Başka firma verisi ASLA paylaşma.
5. Borç/bakiye sorusunda: Toplam Bakiye, Vadesi Geçmiş Bakiye ve Vade Gün bilgilerini açıkça belirt.
5b. Fiyat sorusunda: Önce müşteriye özel "Anlaşılan Fiyat" sütununa bak. Yoksa fiyat listesindeki "kaplama" ve "sıfır jant" fiyatlarını AYRI AYRI göster. Her zaman USD birimi ile belirt. Örn: Kaplama: $65 USD | Sıfır Jant: $85 USD. Kaplama = müşteri kendi jantını getirir. Sıfır Jant = jant dahil fiyat.
6. Sipariş sorusunda: Sipariş adeti, teslim edilen, kalan ve anlaşılan fiyatı belirt.
7. Açık sipariş sorusunda: Kaç gündür beklediğini de söyle.
8. Polyfill/dolum sorusunda: Polyfill Arama Sonucunu kullan, ölçü formatı farklı olsa bile (x, -, /, virgül, nokta) aynı ölçü olarak değerlendir.
9. Cevap verilerde YOKSA (ne teknik bilgi ne müşteri verisi): "Yetkiliye aktarıyorum, en kısa sürede dönüş yapacaklar."
10. Bilinmeyen Müşteri ise: İlk mesajda yalnızca "Sistemimizdeki kaydınızı şu an eşleştiremedim, 0555 016 16 00 numaralı hattımızdan bizimle iletişime geçebilirsiniz" de ve soruyu yanıtla. Sonraki mesajlarda tekrar etme.
11. Her mesajın sonuna kayıt/uyarı ekleme. Doğal bir asistan gibi konuş.
12. Kısa, samimi ve profesyonel Türkçe kullan. Gereksiz uzatma yapma.`;

        console.log('🧠 RobERD düşünüyor...');
        const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();
        console.log('✅ RobERD yanıtladı:', aiResponse);

        await axios.post('https://api.fonnte.com/send', {
            target: sender,
            message: aiResponse,
            countryCode: '0'
        }, { headers: { 'Authorization': FONNTE_TOKEN } });

        console.log(`🚀 GÖNDERİLDİ -> ${sender}`);

    } catch (error) {
        console.error('❌ Hata:', error.message || error);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RobERD - Erdemli CRM Bot ${PORT} portunda çalışıyor.`));
