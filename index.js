require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Session dosyası — Render restart sonrası da korunur
const SESSION_FILE = path.join('/tmp', 'siparis_sessions.json');

function sessionYukle() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            // 2 saatten eski session'ları temizle
            const simdi = Date.now();
            const temiz = {};
            Object.entries(data).forEach(([k, v]) => {
                if (simdi - (v.timestamp || 0) < 7200000) temiz[k] = v;
            });
            return temiz;
        }
    } catch(e) { console.error('Session yükleme hatası:', e.message); }
    return {};
}

function sessionKaydet(sessions) {
    try {
        const obj = {};
        sessions.forEach((v, k) => { obj[k] = v; });
        fs.writeFileSync(SESSION_FILE, JSON.stringify(obj), 'utf8');
    } catch(e) { console.error('Session kaydetme hatası:', e.message); }
}

// Session başlangıçta yüklenir (aşağıda app.listen'den önce)

const app = express();

// ─── SİPARİŞ ONAY AKIŞI — her numara için bekleyen sipariş durumu ───
// Olası state değerleri: 'awaiting_order' | 'awaiting_option' | 'awaiting_confirm'
const siparisSession = new Map();
// { state, cariAdi, telefon, urunAdi, fiyat, adet, timestamp }
// Not: sessionYukle() aşağıda googleapis require'dan sonra çağrılır

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
// WhatsApp siparişlerinin yazılacağı Sheets ID (Erdemli Siparişler dosyası)
// Eğer aynı dosyaysa SID ile aynı bırakın, farklıysa URL'den alıp buraya yazın
const SIPARIS_SID = process.env.SIPARIS_SHEETS_ID || SID;
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

function parseCSV(text, sep) {
    const lines = text.split('\n');
    if (!lines.length) return [];
    // Ayraç otomatik tespit: virgül yoksa | dene
    if (!sep) {
        const ilk = lines[0] || '';
        sep = ilk.includes(',') ? ',' : ilk.includes('|') ? '|' : ',';
    }
    const headers = splitRow(lines[0], sep).map(h => h.trim().replace(/\r/g, ''));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const vals = splitRow(line, sep);
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = (vals[idx] || '').trim().replace(/\r/g, ''); });
        rows.push(obj);
    }
    return rows;
}

function splitRow(line, sep = ',') {
    if (sep === '|') return line.split('|').map(v => v.trim());
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
// TEKNİK BİLGİ AKILLI ARAMA FONKSİYONU — v2
// Kolon adlarını otomatik tespit eder.
// Eşleşen anahtar kelime yoksa TÜM tabloyu gönderir (Gemini karar verir).
// ═══════════════════════════════════════════════════════════════
function teknikBilgiAra(teknikData, mesaj) {
    if (!teknikData || !teknikData.length) return { filtrelenmis: '', toplamSatir: 0 };

    // ── Kolon adlarını otomatik tespit et (büyük/küçük harf, boşluk, Türkçe karakter farkı önemsiz)
    const kolonlar = Object.keys(teknikData[0]);
    const konuKol     = kolonlar.find(k => /konu/i.test(k))              || kolonlar[0];
    const aciklamaKol = kolonlar.find(k => /a[çc][ıi]klama/i.test(k))   || kolonlar[1];
    console.log(`📋 Teknik tablo kolonları: [${kolonlar.join(' | ')}] → KONU="${konuKol}" AÇIKLAMA="${aciklamaKol}"`);

    const msg    = mesaj.toUpperCase().replace(/[_\-\.]/g, ' ');
    const msgLow = mesaj.toLowerCase();
    const anahtarlar = new Set();

    // — Marka tespiti
    ['ELS LIFT','ELS','DINGLI','JCPT','GENIE','JLG','HAULOTTE','SKYJACK','SINOBOOM','LGMG','ZOOMLION','MANITOU']
        .forEach(m => { if (msg.includes(m)) anahtarlar.add(m); });

    // — Model tespiti (EL 12, EL12, JCPT1412DC vb.)
    const modelBulundu = mesaj.match(/\b(EL\s*\d+[\-]?[A-Z]*|JCPT\s*\d+\s*[A-Z]*)\b/gi);
    if (modelBulundu) modelBulundu.forEach(m => anahtarlar.add(m.replace(/\s+/g, ' ').trim().toUpperCase()));

    // — Hata kodu tespiti (hata/arıza kelimesi olmasa bile kod tek başına yazılmışsa yakala)
    const kodRegex = /\b(0[1-9]|[1-9][0-9]|0L|LL)\b/gi;
    const tumKodlar = mesaj.match(kodRegex);
    if (tumKodlar) {
        anahtarlar.add('Hata Kodu');
        tumKodlar.forEach(k => {
            const kUpper = k.toUpperCase();
            anahtarlar.add(`Hata Kodu ${kUpper}`);
            anahtarlar.add(kUpper); // direkt kod numarası ile de ara
        });
    }
    if (/\b(hata|arıza|error|fault|kod|code)\b/gi.test(mesaj)) {
        anahtarlar.add('Hata Kodu');
    }

    // — Teknik konu anahtar kelimeleri
    const konuHaritasi = {
        'bakım':['Bakım','Periyodik'], 'bakim':['Bakım','Periyodik'], 'maintenance':['Bakım','Periyodik'],
        'akü':['Akü','Şarj','Batarya'], 'aku':['Akü','Şarj','Batarya'],
        'şarj':['Şarj','Akü'], 'sarj':['Şarj','Akü'], 'battery':['Akü','Şarj','Batarya'],
        'hidrolik':['Hidrolik'], 'yağ':['Yağ','Hidrolik'], 'yag':['Yağ','Hidrolik'],
        'lastik':['Lastik','Tekerlek'], 'tekerlek':['Tekerlek','Lastik'],
        'fren':['Fren'], 'brake':['Fren'],
        'güvenlik':['Güvenlik'], 'guvenlik':['Güvenlik'], 'safety':['Güvenlik'],
        'eğim':['Eğim'], 'egim':['Eğim'], 'slope':['Eğim'],
        'kapasite':['Kapasite','Yük'], 'capacity':['Kapasite','Yük'],
        'yükseklik':['Yükseklik'], 'yukseklik':['Yükseklik'], 'height':['Yükseklik'],
        'kaldırma':['Yükseklik','Kaldırma'], 'kaldirma':['Yükseklik','Kaldırma'],
        'boyut':['Boyut','Genişlik','Uzunluk'], 'ölçü':['Boyut','Ölçü'], 'olcu':['Boyut','Ölçü'],
        'ağırlık':['Ağırlık'], 'agirlik':['Ağırlık'], 'weight':['Ağırlık'],
        'hız':['Hız','Sürüş'], 'hiz':['Hız','Sürüş'], 'speed':['Hız','Sürüş'],
        'sürüş':['Sürüş','Hız'], 'surus':['Sürüş','Hız'],
        'voltaj':['Voltaj'], 'voltage':['Voltaj'],
        'kumanda':['Kumanda','Kontrol'], 'kontrol':['Kontrol','Kumanda'], 'joystick':['Kumanda'],
        'alarm':['Alarm'], 'acil':['Acil'], 'emergency':['Acil'],
        'elektrik':['Elektrik'], 'electric':['Elektrik'],
        'motor':['Motor'], 'bobin':['Bobin'],
        'sensör':['Sensör'], 'sensor':['Sensör'],
        'arıza':['Hata Kodu','Arıza'], 'ariza':['Hata Kodu','Arıza'], 'hata':['Hata Kodu'], 'fault':['Hata Kodu'],
        'zoomlion':['Zoomlion'], 'dingli':['Dingli'],
        'polyfill':['Polyfill','Dolum'], 'dolum':['Dolum','Polyfill'],
        'taşıma':['Taşıma','Nakil'], 'nakil':['Nakil','Taşıma'], 'transport':['Taşıma','Nakil'],
        'platform':['Platform'], 'sepet':['Platform','Sepet'],
        'çalışma':['Çalışma'], 'calisma':['Çalışma'],
        'özellik':['Özellik'], 'ozellik':['Özellik'], 'teknik':['Teknik'],
    };
    Object.entries(konuHaritasi).forEach(([kelime, etiketler]) => {
        if (msgLow.includes(kelime)) etiketler.forEach(e => anahtarlar.add(e));
    });

    // ── Filtrele
    let eslesen = [];
    if (anahtarlar.size > 0) {
        eslesen = teknikData.filter(r => {
            const konu     = (r[konuKol]     || '').toUpperCase();
            const aciklama = (r[aciklamaKol] || '').toUpperCase();
            const birlesik = konu + ' ' + aciklama;
            return [...anahtarlar].some(a => birlesik.includes(a.toUpperCase()));
        });
    }

    // ── Eşleşme yoksa tüm tabloyu gönder — Gemini karar verir
    const tamTablo = eslesen.length === 0;
    const kaynak   = tamTablo ? teknikData : eslesen;
    // Eşleşme varsa tümünü gönder; eşleşme yoksa (tüm tablo) max 300 satır
    const sinirli  = tamTablo ? kaynak.slice(0, 300) : kaynak;
    const metin    = sinirli.map(r => `• ${r[konuKol] || ''}: ${r[aciklamaKol] || ''}`).join('\n');

    console.log(`🔍 Teknik bilgi: anahtar=[${[...anahtarlar].join(', ')}] → ${eslesen.length} eşleşme${tamTablo ? ' (YOK → tüm tablo)' : ''} | gönderilen: ${sinirli.length}/${kaynak.length}`);

    return { filtrelenmis: metin, toplamSatir: kaynak.length, tamTablo };
}

// Mevcut markalar/modeller listesi (genel bilgi için)
function teknikBilgiOzet(teknikData) {
    if (!teknikData || !teknikData.length) return '';
    const kolonlar  = Object.keys(teknikData[0]);
    const konuKol   = kolonlar.find(k => /konu/i.test(k)) || kolonlar[0];
    const markalar  = new Set();
    teknikData.forEach(r => {
        const konu = r[konuKol] || '';
        const match = konu.match(/^(ELS\s*Lift|Dingli|Genie|JLG|Haulotte|Skyjack|Sinoboom|LGMG|Zoomlion|Manitou)\s+(\S+)/i);
        if (match) markalar.add(`${match[1]} ${match[2]}`);
    });
    return markalar.size
        ? `Teknik bilgi tabanındaki modeller: ${[...markalar].join(', ')} (toplam ${teknikData.length} kayıt)`
        : `Teknik bilgi tabanı mevcut (${teknikData.length} kayıt)`;
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

// ═══════════════════════════════════════════════════════════════
// GOOGLE SHEETS — SERVİS HESABI İLE YAZ
// .env içinde GOOGLE_SERVICE_ACCOUNT_JSON='{...json...}' olmalı
// ═══════════════════════════════════════════════════════════════
async function sheetsAuth() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return auth;
}

async function siparisiSheetsYaz(siparis) {
    try {
        const auth = await sheetsAuth();
        const sheets = google.sheets({ version: 'v4', auth });
        const tarih = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
        await sheets.spreadsheets.values.append({
            spreadsheetId: SIPARIS_SID,
            range: 'WhatsApp Siparisleri!A:G',
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [[
                    tarih,
                    siparis.cariAdi,
                    siparis.telefon,
                    siparis.urunAdi,
                    siparis.fiyat,
                    siparis.adet || 1,
                    'WhatsApp Bot'
                ]],
            },
        });
        console.log(`Siparis Sheets'e yazildi: ${siparis.cariAdi}`);
        return true;
    } catch (err) {
        console.error('Sheets yazma hatasi:', err.message);
        return false;
    }
}

function fiyatVarMi(metin) {
    // Hem USD/$ içeren normal fiyat hem de [URUN:|FIYAT:] tag'i ara
    return /(\$[\d,.]+|[\d][\d,.]*\s*USD|\[URUN:)/i.test(metin);
}

function fiyatBilgisiCikar(metin) {
    // Gemini tag formatı: [URUN:ürün|KAPLAMA:$65 USD|SIFIRJANT:$95 USD]
    // veya tek fiyat:     [URUN:ürün|FIYAT:$65 USD]
    const tagMatch = metin.match(/\[URUN:([^|\]]+)\|KAPLAMA:([^|\]]+)\|SIFIRJANT:([^\]]+)\]/i);
    if (tagMatch) {
        return {
            urunAdi:      tagMatch[1].trim(),
            kaplamaFiyat: tagMatch[2].trim(),
            sifirJant:    tagMatch[3].trim(),
            ciftOpsiyon:  true,
        };
    }
    const tekFiyatMatch = metin.match(/\[URUN:([^|\]]+)\|FIYAT:([^\]]+)\]/i);
    if (tekFiyatMatch) {
        return {
            urunAdi:     tekFiyatMatch[1].trim(),
            fiyat:       tekFiyatMatch[2].trim(),
            ciftOpsiyon: false,
        };
    }
    // Fallback
    const fiyatMatch = metin.match(/(\$[\d,.]+\s*(?:USD)?|[\d][\d,.]*\s*USD)/i);
    const fiyat = fiyatMatch ? fiyatMatch[0].trim() : 'Belirtilmedi';
    const urunMatch = metin.match(/([\d]{2,4}[.,\/\-][\d]{1,3}[.,\/\-][\d]{1,3}[^\s,\n]{0,20})/i);
    const urunAdi = urunMatch ? urunMatch[0].trim() : 'Talep edilen ürün';
    return { fiyat, urunAdi, ciftOpsiyon: false };
}

// Gemini yanıtından [URUN:|FIYAT:] tag'ini temizle (müşteriye gönderilmeden önce)
function temizleYanit(metin) {
    return metin.replace(/\s*\[URUN:[^\]]+\]/gi, '').trim();
}

app.post('/webhook', async (req, res) => {
    res.status(200).send({ status: true });
    const sender  = req.body.sender;
    const message = req.body.message || req.body.text;
    if (!sender || !message) { console.log('Sender veya mesaj yok'); return; }

    try {
        console.log(`\n💬 ${sender} | ${message}`);

        // ═══════════════════════════════════════════════════════════════
        // SİPARİŞ ONAY AKIŞI — Gemini'ye gerek yok, doğrudan yönetilir
        // ═══════════════════════════════════════════════════════════════
        const session = siparisSession.get(sender);
        const msgNorm = message.trim().toUpperCase();

        // AŞAMA 2: Müşteri "EVET" veya "HAYIR" dedi (sipariş teklifi bekleniyor)
        if (session && session.state === 'awaiting_order') {
            if (msgNorm === '1' || msgNorm.includes('EVET') || msgNorm.includes('SİPARİŞ VER') || msgNorm.includes('SIPARIS VER')) {

                if (session.ciftOpsiyon) {
                    // Çift opsiyon — kaplama mı sıfır jant mı sor
                    const opsiyonMesaji =
`🔧 *Hangi seçeneği istersiniz?*

1️⃣ *Kaplama* — ${session.kaplamaFiyat}
   _(Kendi jantınızı getirirsiniz)_

2️⃣ *Sıfır Jantlı* — ${session.sifirJant}
   _(Jant dahil teslim edilir)_

*1* veya *2* yazın.`;

                    siparisSession.set(sender, { ...session, state: 'awaiting_option' }); sessionKaydet(siparisSession);

                    await axios.post('https://api.fonnte.com/send', {
                        target: sender,
                        message: opsiyonMesaji,
                        buttons: JSON.stringify([
                            {id:'1', title:'Kaplama'},
                            {id:'2', title:'Sıfır Jantlı'}
                        ]),
                        countryCode: '0'
                    }, { headers: { 'Authorization': FONNTE_TOKEN } });
                    console.log(`🔧 Opsiyon sorusu gönderildi -> ${sender}`);
                    return;
                }

                // Tek fiyat — direkt onay formuna geç
                const onayMesaji =
`📋 *SİPARİŞ ONAY FORMU*

👤 Müşteri: ${session.cariAdi}
📦 Ürün: ${session.urunAdi}
💰 Fiyat: ${session.fiyat}
📅 Tarih: ${new Date().toLocaleDateString('tr-TR')}

Siparişinizi onaylamak için *ONAYLA* yazın.
İptal etmek için *İPTAL* yazın.`;

                siparisSession.set(sender, { ...session, state: 'awaiting_confirm' }); sessionKaydet(siparisSession);

                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: onayMesaji,
                    button: JSON.stringify(['Onayla', 'İptal Et']),
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });

                console.log(`📋 Onay formu gönderildi -> ${sender}`);
                return;

            } else if (msgNorm === '2' || msgNorm.includes('HAYIR') || msgNorm.includes('VAZGEÇTİM')) {
                siparisSession.delete(sender); sessionKaydet(siparisSession);
                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: 'Anlaşıldı, sipariş verilmedi. Başka bir konuda yardımcı olabilir miyim? 😊',
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                console.log(`❌ Sipariş iptal edildi -> ${sender}`);
                return;
            } else {
                // Farklı bir şey yazdı — uyar, session'ı koru
                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: '❓ Lütfen *1* (Evet) veya *2* (Hayır) yazın.',
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                return;
            }
        }

        // AŞAMA 2.5: Müşteri kaplama/sıfır jant seçti
        if (session && session.state === 'awaiting_option') {
            let secim = null;
            if (msgNorm === '1' || msgNorm.includes('KAPLAMA')) {
                secim = { tip: 'Kaplama', fiyat: session.kaplamaFiyat };
            } else if (msgNorm === '2' || msgNorm.includes('SIFIR') || msgNorm.includes('JANT')) {
                secim = { tip: 'Sıfır Jantlı', fiyat: session.sifirJant };
            }

            if (secim) {
                const onayMesaji =
`📋 *SİPARİŞ ONAY FORMU*

👤 Müşteri: ${session.cariAdi}
📦 Ürün: ${session.urunAdi}
🔧 Seçenek: ${secim.tip}
💰 Fiyat: ${secim.fiyat}
📅 Tarih: ${new Date().toLocaleDateString('tr-TR')}

Siparişinizi onaylamak için *ONAYLA* yazın.
İptal etmek için *İPTAL* yazın.`;

                siparisSession.set(sender, {
                    ...session,
                    state: 'awaiting_confirm',
                    fiyat: `${secim.tip} - ${secim.fiyat}`,
                }); sessionKaydet(siparisSession);

                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: onayMesaji,
                    button: JSON.stringify(['Onayla', 'İptal Et']),
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                console.log(`📋 Onay formu gönderildi (${secim.tip}) -> ${sender}`);
                return;
            } else {
                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: '❓ Lütfen *1* (Kaplama) veya *2* (Sıfır Jantlı) yazın.',
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                return;
            }
        }

        // AŞAMA 3: Müşteri "ONAYLA" veya "İPTAL" dedi
        if (session && session.state === 'awaiting_confirm') {
            if (msgNorm === '1' || msgNorm === 'ONAYLA') {
                // Google Sheets'e yaz
                const yazildi = await siparisiSheetsYaz({
                    cariAdi: session.cariAdi,
                    telefon: sender,
                    urunAdi: session.urunAdi,
                    fiyat:   session.fiyat,
                    adet:    1,
                });
                siparisSession.delete(sender); sessionKaydet(siparisSession);

                const sonucMesaji = yazildi
                    ? `✅ *Siparişiniz alındı!*\n\nEn kısa sürede sizinle iletişime geçeceğiz. Teşekkürler! 🙏`
                    : `✅ *Siparişiniz alındı!*\n\nEkibimiz en kısa sürede sizi arayacak.`;

                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: sonucMesaji,
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });

                console.log(`✅ Sipariş onaylandı ve kaydedildi -> ${sender}`);
                return;

            } else if (msgNorm === '2' || msgNorm.includes('İPTAL') || msgNorm.includes('IPTAL')) {
                siparisSession.delete(sender); sessionKaydet(siparisSession);
                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: 'Sipariş iptal edildi. Başka bir konuda yardımcı olabilir miyim? 😊',
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                console.log(`❌ Sipariş iptal edildi -> ${sender}`);
                return;
            } else {
                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: '❓ Lütfen *1* (Onayla) veya *2* (İptal Et) yazın.',
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                return;
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // NORMAL AKIŞ — Gemini ile yanıt üret
        // ═══════════════════════════════════════════════════════════════
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
${teknikSonuc.filtrelenmis ? `\nMesajla ilgili bulunan teknik bilgiler (${teknikSonuc.toplamSatir} kayıt${teknikSonuc.tamTablo ? ' — eşleşme bulunamadı, tüm tablo gönderildi' : ''}):\n${teknikSonuc.filtrelenmis}` : '\n(Teknik bilgi tabanı boş veya yüklenemedi)'}

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
12. Kısa, samimi ve profesyonel Türkçe kullan. Gereksiz uzatma yapma.
13. FİYAT İÇEREN YANIT: Eğer yanıtında fiyat (USD veya $) geçiyorsa yanıtının EN SONUNA şu tag'i MUTLAKA ekle (müşteri görmez, sistem okur):
- Hem kaplama hem sıfır jant fiyatı varsa: [URUN:ürün adı|KAPLAMA:kaplama fiyatı|SIFIRJANT:sıfır jant fiyatı]
  Örnek: [URUN:15x5 Tekerlek (Genie)|KAPLAMA:$65 USD|SIFIRJANT:$95 USD]
- Sadece tek fiyat varsa: [URUN:ürün adı|FIYAT:fiyat]
  Örnek: [URUN:23.5-25 Kaplama|FIYAT:$65 USD]`;

        console.log('🧠 RobERD düşünüyor...');
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();
        console.log('✅ RobERD yanıtladı:', aiResponse);

        // Tag'i müşteriye göstermeden önce temizle
        const temizMesaj = temizleYanit(aiResponse);

        await axios.post('https://api.fonnte.com/send', {
            target: sender,
            message: temizMesaj,
            countryCode: '0'
        }, { headers: { 'Authorization': FONNTE_TOKEN } });

        console.log(`🚀 GÖNDERİLDİ -> ${sender}`);

        // ─── AŞAMA 1: Bot fiyat verdiyse sipariş teklifi gönder ───
        if (fiyatVarMi(aiResponse)) {
            const bilgi = fiyatBilgisiCikar(aiResponse);
            siparisSession.set(sender, {
                state:       'awaiting_order',
                cariAdi,
                telefon:     sender,
                urunAdi:     bilgi.urunAdi,
                fiyat:       bilgi.fiyat || '',
                kaplamaFiyat: bilgi.kaplamaFiyat || '',
                sifirJant:   bilgi.sifirJant || '',
                ciftOpsiyon: bilgi.ciftOpsiyon || false,
                timestamp:   Date.now(),
            }); sessionKaydet(siparisSession);
            // Kısa bir gecikme ile sipariş sorusunu gönder
            setTimeout(async () => {
                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: '🛒 Bu ürünü sipariş vermek ister misiniz?',
                    buttons: JSON.stringify([
                        {id:'1', title:'✅ Evet, sipariş ver'},
                        {id:'2', title:'❌ Hayır, vazgeçtim'}
                    ]),
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                console.log(`🛒 Sipariş teklifi gönderildi -> ${sender} | Ürün: ${bilgi.urunAdi} | Fiyat: ${bilgi.fiyat || bilgi.kaplamaFiyat}`);
            }, 1500);
        }

    } catch (error) {
        console.error('❌ Hata:', error.message || error);
    }
});

// Başlangıçta session'ları dosyadan yükle
try {
    const yukluData = sessionYukle();
    Object.entries(yukluData).forEach(([k, v]) => siparisSession.set(k, v));
    console.log(`📂 ${Object.keys(yukluData).length} aktif session yüklendi`);
} catch(e) {}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RobERD - Erdemli CRM Bot ${PORT} portunda çalışıyor.`));
