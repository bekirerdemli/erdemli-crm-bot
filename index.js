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
// Olası state değerleri: 'awaiting_order' | 'awaiting_option' | 'awaiting_adet' | 'awaiting_confirm'
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

// PDF dosyalarını servis et — Fonnte bu URL'den PDF'i indirir
const PDF_DIR = '/tmp/kaulas_pdfs';
const fsExtra = require('fs');
if (!fsExtra.existsSync(PDF_DIR)) fsExtra.mkdirSync(PDF_DIR, { recursive: true });
app.use('/pdf', require('express').static(PDF_DIR));

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
const GRUP_ID = process.env.WHATSAPP_GRUP_ID || ''; // Render'da WHATSAPP_GRUP_ID olarak ekleyin
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
    makinalar:      `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=619309813`,
    makinalarEski:  `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=1621316106`,
    polyfill:       `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=174636469`,
    teknikBilgi:    `https://docs.google.com/spreadsheets/d/${SID}/export?format=csv&gid=1461616374`,
    islemler:       `https://docs.google.com/spreadsheets/d/${IID}/export?format=csv&gid=1884664027`,
    bakiye:         `https://docs.google.com/spreadsheets/d/${IID}/export?format=csv&gid=754315254`,
};

function parseCSV(text, sep) {
    const lines = text.split('\n');
    if (!lines.length) return [];
    if (!sep) {
        const ilk = lines[0] || '';
        sep = ilk.includes(',') ? ',' : ilk.includes('|') ? '|' : ',';
    }
    const headers = splitRow(lines[0], sep).map(h => h.trim().replace(/\r/g, '').replace(/\n/g, ' '));
    console.log('📊 CSV başlıkları (' + headers.length + '):', headers.join(' | '));
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


// ═══════════════════════════════════════════════════════════════
// İÇDAŞ ENTEGRASYONu — Kaupan API
// ═══════════════════════════════════════════════════════════════
const icdasSession = new Map(); // sender → { state, timestamp }

const ICDAS_MENU = `Merhaba! 👋 Kaulas Lastik olarak İÇDAŞ ÇELİK ENERJİ sistemine hoş geldiniz.

Aşağıdaki konularda size yardımcı olabilirim:

1️⃣ Açık Sipariş Listele
2️⃣ Kapalı Sipariş Listele
3️⃣ Envanter Stok Kontrolü
4️⃣ İrsaliye Kontrolü
5️⃣ Tekerlek Dolum Detayı Sorgulama

Lütfen ilgili numarayı yazınız.`;

const ICDAS_ALT_MENU = '\n─────────────────\n0️⃣ Ana Menüye Dön';

const ICDAS_GECERSIZ = `Bu konuda yardımcı olma yetkim bulunmuyor. 
Lütfen yukarıdaki menüden bir seçenek yazınız (1-5).`;

const ICDAS_ISRAR = `Anladım, konuyu ilgili yetkiliye bildiriyorum. En kısa sürede size dönüş yapacaklar. 
Görüşmemiz sonlanmıştır. Tekrar bağlanmak için herhangi bir mesaj yazabilirsiniz.`;

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
const ICDAS_API = 'http://84.44.77.42:3939/kaulas/api_kaupan_info.php';
const ICDAS_ANAHTAR_KELIMELER = ['İÇDAŞ', 'ICDAS', 'İCDAŞ', 'IÇDAŞ'];

function normalize(str) {
    return (str || '').toUpperCase()
        .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G')
        .replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');
}

function icdasMi(cariAdi) {
    const cu = normalize(cariAdi);
    // Hem kısa hem uzun haliyle kontrol et
    const kontroller = ['ICDAS','ICTAS','ICTAŞ','ICDAS CELIK','ICDAS CELIK ENERJI'];
    const eslesti = kontroller.some(k => cu.includes(normalize(k)));
    console.log(`[İçdaş kontrol] "${cariAdi}" → normalize: "${cu}" → eşleşti: ${eslesti}`);
    return eslesti;
}

async function icdasVeriCek(section = 'all', q = null, limit = 500) {
    try {
        const url = new URL(ICDAS_API);
        url.searchParams.set('section', section);
        url.searchParams.set('limit', String(limit));
        if (q) url.searchParams.set('q', q);
        const res = await axios.get(url.toString(), { timeout: 10000 });
        return res.data;
    } catch(e) {
        console.error('İçdaş API hatası:', e.message);
        return null;
    }
}

// Sipariş detay API — SiparisNo ile arama yap, tüm satır ve irsaliye detaylarını getir
async function icdasSiparisDetayGetir(siparisNo, siparisId) {
    const sonuclar = { satirlar: [], sipDolumlar: [], irsaliye: null, stokMap: {}, irsNolar: [] };

    // Tüm verileri paralel çek — JSON + HTML + irsaliye + dolum
    const [jsonRes, htmlRes, irsRes, dolumRes] = await Promise.allSettled([
        axios.get(`http://84.44.77.42:3939/kaulas/siparis_detay_pdf.php?Id=${siparisId}&json=1`, { timeout: 10000 }),
        axios.get(`http://84.44.77.42:3939/kaulas/siparis_detay_pdf.php?Id=${siparisId}`, { timeout: 10000 }),
        axios.get(`http://84.44.77.42:3939/kaulas/api_kaupan_info.php?section=irsaliye&limit=500`, { timeout: 10000 }),
        axios.get(`http://84.44.77.42:3939/kaulas/api_kaupan_info.php?section=dolum&limit=500`, { timeout: 10000 })
    ]);

    // ── ADIM 1: İrsaliye no'larını HTML'den her zaman çek ──
    let htmlContent = '';
    if (htmlRes.status === 'fulfilled') {
        htmlContent = String(htmlRes.value.data || '');
        const irsNolar = [...new Set((htmlContent.match(/(?:KLI|IC|TIS|MTU)\d+/g) || []))];
        sonuclar.irsNolar = irsNolar;
        console.log('İrsaliye nolar HTML:', irsNolar);
    }

    // ── ADIM 2: Sipariş satırlarını JSON'dan dene ──
    let satirlarBulundu = false;
    if (jsonRes.status === 'fulfilled') {
        const json = jsonRes.value.data;
        console.log('JSON detay ham:', JSON.stringify(json).substring(0, 500));
        // JSON'dan irsaliye numaralarını da ekle
        const irsNoKaynagi = json?.irsNolar || json?.data?.irsNolar || json?.irsaliyeNolar || null;
        if (Array.isArray(irsNoKaynagi) && irsNoKaynagi.length > 0)
            sonuclar.irsNolar = [...new Set([...sonuclar.irsNolar, ...irsNoKaynagi])];
        const satirKaynagi = json?.satirlar || json?.data?.satirlar || json?.siparisDetay ||
            json?.data?.siparisDetay || json?.detaylar || json?.data?.detaylar ||
            json?.rows || json?.items || json?.urunler || null;
        if (Array.isArray(satirKaynagi) && satirKaynagi.length > 0) {
            const satirlar = satirKaynagi.map(s => {
                const urunAdi     = (s.UrunAdi || s.urunAdi || s.StokAdi || s.stokAdi || s.Aciklama || s.aciklama || '').trim();
                const sipMiktar   = parseFloat((s.SiparisMiktar || s.siparisMiktar || s.Miktar || s.miktar || s.SipMiktar || '0').toString().replace(',', '.')) || 0;
                const teslimAlinan= parseFloat((s.TeslimAlinan  || s.teslimAlinan  || s.GelenMiktar || '0').toString().replace(',', '.')) || 0;
                const gonderilen  = parseFloat((s.GonderilenMiktar || s.gonderilenMiktar || s.GidenMiktar || s.Gonderilen || '0').toString().replace(',', '.')) || 0;
                const kalanMiktar = Math.abs(parseFloat((s.Kalan || s.kalan || s.KalanMiktar || '0').toString().replace(',', '.')) || 0);
                return { urunAdi, sipMiktar, teslimAlinan, gonderilen, kalanMiktar };
            }).filter(s => s.urunAdi && s.sipMiktar > 0);
            if (satirlar.length > 0) {
                console.log('JSON satirlar:', JSON.stringify(satirlar));
                sonuclar.satirlar = satirlar;
                satirlarBulundu = true;
            }
        }
    }

    // ── ADIM 3: JSON'da satır yoksa HTML'den parse et ──
    if (!satirlarBulundu && htmlContent) {
        const satirlar = [];
        const trParts = htmlContent.split(/<tr[\s>]/i);
        for (const trPart of trParts) {
            const tdValues = [];
            const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
            let m;
            while ((m = tdRegex.exec(trPart)) !== null) {
                const text = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
                tdValues.push(text);
            }
            if (tdValues.length >= 6 && /^\d+$/.test(tdValues[0])) {
                const urunAdi      = (tdValues[1] || '').trim();
                const sipMiktar    = parseFloat((tdValues[2] || '0').replace(',', '.')) || 0;
                const teslimAlinan = parseFloat((tdValues[3] || '0').replace(',', '.')) || 0;
                const gonderilen   = parseFloat((tdValues[4] || '0').replace(',', '.')) || 0;
                const kalanMiktar  = Math.abs(parseFloat((tdValues[5] || '0').replace(',', '.')) || 0);
                if (urunAdi && sipMiktar > 0)
                    satirlar.push({ urunAdi, sipMiktar, teslimAlinan, gonderilen, kalanMiktar });
            }
        }
        console.log('HTML fallback satirlar:', JSON.stringify(satirlar));
        sonuclar.satirlar = satirlar;
    }

    // İrsaliye listesi
    if (irsRes.status === 'fulfilled') {
        sonuclar.irsaliye = irsRes.value.data;
    }

    // Dolum listesi
    if (dolumRes.status === 'fulfilled') {
        const tumDevam = dolumRes.value.data?.data?.dolum?.listeler?.devamEden || [];
        const tumTamam = dolumRes.value.data?.data?.dolum?.listeler?.sonTamamlanan || [];
        sonuclar.sipDolumlar = [...tumDevam, ...tumTamam].filter(d => (d.SiparisNo || '') === siparisNo);
    }

    return sonuclar;
}

async function icdasCevapla(sender, message, yetkiliAdi) {
    console.log('🏭 İçdaş modu aktif');

    const selamAdi = yetkiliAdi ? ` ${yetkiliAdi.split(' ')[0]}` : '';
    const ses = icdasSession.get(sender) || { state: 'menu', timestamp: Date.now() };

    // Mesaj normalizasyonu
    const msgTemiz = message.trim();
    const msgSayi = msgTemiz.match(/^[0-5]$/)?.[0];

    // ── SONLANDIRILMIŞ görüşme — yeni mesajda menüye dön ──
    if (ses.state === 'bitti') {
        icdasSession.set(sender, { state: 'menu', timestamp: Date.now() });
        await whatsappGonder(sender, ICDAS_MENU.replace('Merhaba! 👋', `Tekrar hoş geldiniz${selamAdi}! 👋`));
        return;
    }

    // ── PDF BEKLEME MODU — kullanıcı 1 (PDF) veya 0 (menü) yazacak ──
    if (ses.pdfMod) {
        if (msgTemiz === '0') {
            icdasSession.set(sender, { state: 'menu', timestamp: Date.now() });
            await whatsappGonder(sender, ICDAS_MENU.replace('Merhaba!', `Merhaba${selamAdi}!`));
            return;
        }
        if (msgTemiz === '1') {
            icdasSession.set(sender, { ...ses, pdfMod: false, timestamp: Date.now() });
            await whatsappGonder(sender, '⏳ PDF hazırlanıyor...');
            try {
                const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
                if (!BASE_URL) throw new Error('BASE_URL env tanımlı değil');

                const pdfSrcUrl = `http://84.44.77.42:3939/kaulas/siparis_detay_pdf.php?Id=${ses.pdfSipId}`;
                const pdfFileName = `siparis_${ses.pdfSipNo}_${Date.now()}.pdf`;
                const pdfLocalPath = path.join(PDF_DIR, pdfFileName);
                const pdfPublicUrl = `${BASE_URL}/pdf/${pdfFileName}`;

                console.log(`📥 PDF indiriliyor: ${pdfSrcUrl}`);
                const pdfRes = await axios.get(pdfSrcUrl, { responseType: 'arraybuffer', timeout: 20000 });
                const pdfBuffer = Buffer.from(pdfRes.data);

                const pdfHeader = pdfBuffer.slice(0, 5).toString('ascii');
                if (!pdfHeader.startsWith('%PDF')) {
                    throw new Error(`Sunucu PDF döndürmedi (${pdfHeader.substring(0,10)})`);
                }

                fs.writeFileSync(pdfLocalPath, pdfBuffer);
                console.log(`📄 PDF kaydedildi: ${pdfLocalPath} (${pdfBuffer.length} byte)`);

                await whatsappPdfGonder(sender, pdfPublicUrl, `📄 Sipariş No: ${ses.pdfSipNo}`);
                console.log(`✅ PDF gönderildi -> ${sender}`);

                // Menü seçeneği gönder
                await whatsappGonder(sender, `─────────────────\n0️⃣ Ana Menüye Dön`);

                // 10 dk sonra dosyayı sil
                setTimeout(() => {
                    try { fs.unlinkSync(pdfLocalPath); } catch(e) {}
                }, 600000);
            } catch(e) {
                console.error('PDF gönderim hatası:', e.message);
                await whatsappGonder(sender,
                    `⚠️ PDF gönderilemedi: ${e.message}\n\n─────────────────\n0️⃣ Ana Menüye Dön`
                );
            }
            return;
        }
        // Başka bir tuş — hatırlat
        await whatsappGonder(sender, `📄 PDF için *1*, Ana Menü için *0* yazınız.`);
        return;
    }

    // ── AÇIK SİPARİŞ LİSTESİNDEYKEN — numara yazılırsa detay aç (EN ÖNCE KONTROL ET) ──
    if (ses.acikMod && ses.acikSiparisler && msgTemiz !== '0') {
        const siraMatch = msgTemiz.match(/^([1-9])$/);
        const sipNoMatch = msgTemiz.match(/^\d{7,}$/);
        let bulunan = null;
        if (siraMatch) bulunan = ses.acikSiparisler[parseInt(siraMatch[1]) - 1] || null;
        else if (sipNoMatch) bulunan = ses.acikSiparisler.find(s => s.SiparisNo === msgTemiz) || null;

        if (bulunan) {
            icdasSession.set(sender, { ...ses, acikMod: false, timestamp: Date.now() });
            await whatsappGonder(sender, '⏳ Sipariş detayı yükleniyor...');
            try {
                const sipNo = bulunan.SiparisNo;
                const sipId = bulunan.Id;

                // Detay verilerini çek (sadece satır kırılımı için)
                const detay = await icdasSiparisDetayGetir(sipNo, sipId);
                const satirlar = detay.satirlar || [];

                function tekerlerMi(ad) { return (ad||'').toUpperCase().includes('TEKERLEK'); }

                const siparisEbat    = {};
                const teslimAlinanEB = {};
                const teslimEdilenEB = {};
                const kalanEB        = {};
                satirlar.forEach(s => {
                    siparisEbat[s.urunAdi]    = s.sipMiktar;
                    teslimAlinanEB[s.urunAdi] = s.teslimAlinan;
                    teslimEdilenEB[s.urunAdi] = s.gonderilen;
                    kalanEB[s.urunAdi]        = s.kalanMiktar;
                });

                const kalan = (parseFloat(bulunan.ToplamMiktar)||0) - (parseFloat(bulunan.TeslimAlinan)||0);
                const tekerUrunler = Object.keys(siparisEbat).filter(tekerlerMi);

                // ── Detay mesajı oluştur (2. resim formatı) ──
                let dm = `🧾 *Sipariş Detayı*\n\n`;
                dm += `*Sipariş No:* ${sipNo}\n`;
                dm += `*Tarih:* ${(bulunan.SiparisTarihi||'').substring(0,10)}\n`;
                dm += `*Durum:* ${bulunan.DurumEtiket}\n`;

                if (tekerUrunler.length > 0) {
                    dm += `\n📋 *Sipariş Edilen:*\n`;
                    tekerUrunler.forEach(ad => { dm += `· ${ad} - ${siparisEbat[ad]} Adet\n`; });

                    const teslimAlinanList = tekerUrunler.filter(ad => teslimAlinanEB[ad] > 0);
                    if (teslimAlinanList.length) {
                        dm += `\n📥 *Teslim Alınan:*\n`;
                        teslimAlinanList.forEach(ad => { dm += `· ${ad} - ${teslimAlinanEB[ad]} Adet\n`; });
                    }

                    const teslimEdilenList = tekerUrunler.filter(ad => teslimEdilenEB[ad] > 0);
                    if (teslimEdilenList.length) {
                        dm += `\n📤 *Teslim Edilen:*\n`;
                        teslimEdilenList.forEach(ad => { dm += `· ${ad} - ${teslimEdilenEB[ad]} Adet\n`; });
                    }

                    const kalanList = tekerUrunler.filter(ad => kalanEB[ad] > 0);
                    if (kalanList.length) {
                        dm += `\n⏳ *Kalan Sipariş:*\n`;
                        kalanList.forEach(ad => { dm += `· ${ad} - ${kalanEB[ad]} Adet\n`; });
                    } else {
                        dm += `\n✅ *Kalan Sipariş:* Yok\n`;
                    }
                } else {
                    // Satır detayı yoksa toplam bilgi
                    dm += `\nToplam: ${bulunan.ToplamMiktar} | Teslim: ${bulunan.TeslimAlinan} | Kalan: ${kalan}\n`;
                }

                dm += `\n─────────────────\n`;
                dm += `📄 Detaylı PDF için *1*\n`;
                dm += `🔙 Ana Menüye dönmek için *0*`;

                // Session'a PDF bekleme durumu kaydet
                icdasSession.set(sender, {
                    ...ses,
                    acikMod: false,
                    pdfMod: true,
                    pdfSipId: sipId,
                    pdfSipNo: sipNo,
                    timestamp: Date.now()
                });

                await whatsappGonder(sender, dm);

            } catch(e) {
                console.error('Detay hatası:', e.message);
                const kalan = (parseFloat(bulunan.ToplamMiktar)||0) - (parseFloat(bulunan.TeslimAlinan)||0);
                await whatsappGonder(sender,
                    `📋 *${bulunan.SiparisNo}*\n` +
                    `Tarih: ${(bulunan.SiparisTarihi||'').substring(0,10)} | Durum: ${bulunan.DurumEtiket}\n` +
                    `Toplam: ${bulunan.ToplamMiktar} | Teslim: ${bulunan.TeslimAlinan} | Kalan: ${kalan}\n` +
                    `\n─────────────────\n0️⃣ Ana Menüye Dön`
                );
            }
            return;
        }
        // Geçersiz sıra numarası — listeyi tekrar göster
        await whatsappGonder(sender, `Geçersiz seçim. Lütfen listeden bir numara yazınız.\n─────────────────\n0️⃣ Ana Menüye Dön`);
        return;
    }

    // ── MENÜ bekleniyor ──
    if (ses.state === 'menu' || ses.state === 'israr') {
        if (!msgSayi) {
            // İlk gelişte menü göster
            if (ilkMesajMi(sender)) {
                icdasSession.set(sender, { state: 'menu', timestamp: Date.now() });
                await whatsappGonder(sender, ICDAS_MENU.replace('Merhaba!', `Merhaba${selamAdi}!`));
                return;
            }
            // Geçersiz giriş — israr sayacı
            const israrSayisi = (ses.israr || 0) + 1;
            if (israrSayisi >= 2) {
                // 2. kez geçersiz — yetkili bildirimi + sonlandır
                icdasSession.set(sender, { state: 'bitti', timestamp: Date.now() });
                await whatsappGonder(sender, ICDAS_ISRAR);
                // Yetkili bildirimi gönder
                const YETKILI_NO = '905550161600';
                await whatsappGonder(YETKILI_NO, 
                    `⚠️ İÇDAŞ bildirimi\n\nNumara: +${sender}\nMesaj: "${msgTemiz}"\n\nMenü dışı soru sormaya ısrar etti, görüşme sonlandırıldı.`
                );
                return;
            }
            icdasSession.set(sender, { state: 'menu', israr: israrSayisi, timestamp: Date.now() });
            await whatsappGonder(sender, ICDAS_GECERSIZ + '\n\n1️⃣ Açık Sipariş Listele\n2️⃣ Kapalı Sipariş Listele\n3️⃣ Envanter Stok Kontrolü\n4️⃣ İrsaliye Kontrolü\n5️⃣ Tekerlek Dolum Detayı Sorgulama');
            return;
        }
        // Geçerli seçim
        if (msgSayi === '0') {
            icdasSession.set(sender, { state: 'menu', timestamp: Date.now() });
            await whatsappGonder(sender, ICDAS_MENU.replace('Merhaba!', `Merhaba${selamAdi}!`));
            return;
        }
        icdasSession.set(sender, { state: 'islem_' + msgSayi, timestamp: Date.now() });
        await icdasIslemYap(sender, msgSayi, selamAdi);
        return;
    }

    // ── İLK mesaj — menüyü göster ──
    if (ilkMesajMi(sender)) {
        icdasSession.set(sender, { state: 'menu', timestamp: Date.now() });
        await whatsappGonder(sender, ICDAS_MENU.replace('Merhaba!', `Merhaba${selamAdi}!`));
        return;
    }

    // ── İşlem yapıldı, yeni mesaj geldi — geçerli seçim mi? ──
    if (msgSayi) {
        if (msgSayi === '0') {
            icdasSession.set(sender, { state: 'menu', timestamp: Date.now() });
            await whatsappGonder(sender, ICDAS_MENU.replace('Merhaba!', `Merhaba${selamAdi}!`));
            return;
        }
        icdasSession.set(sender, { state: 'islem_' + msgSayi, timestamp: Date.now() });
        await icdasIslemYap(sender, msgSayi, selamAdi);
    } else {
        // Geçersiz — menüye yönlendir
        const israrSayisi = (ses.israr || 0) + 1;
        if (israrSayisi >= 2) {
            icdasSession.set(sender, { state: 'bitti', timestamp: Date.now() });
            await whatsappGonder(sender, ICDAS_ISRAR);
            const YETKILI_NO = '905550161600';
            await whatsappGonder(YETKILI_NO,
                `⚠️ İÇDAŞ bildirimi\n\nNumara: +${sender}\nMesaj: "${msgTemiz}"\n\nMenü dışı soru sormaya ısrar etti, görüşme sonlandırıldı.`
            );
            return;
        }
        icdasSession.set(sender, { state: 'menu', israr: israrSayisi, timestamp: Date.now() });
        await whatsappGonder(sender, ICDAS_GECERSIZ + '\n\n1️⃣ Açık Sipariş Listele\n2️⃣ Kapalı Sipariş Listele\n3️⃣ Envanter Stok Kontrolü\n4️⃣ İrsaliye Kontrolü\n5️⃣ Tekerlek Dolum Detayı Sorgulama');
    }
}

async function icdasIslemYap(sender, secim, selamAdi) {
    let mesaj = '';
    
    try {
        switch(secim) {
            case '1': { // Açık Siparişler — sadece liste
                const vS = await icdasVeriCek('siparis', null, 500);
                const acik = vS?.data?.siparis?.listeler?.acik || [];
                
                if (!acik.length) {
                    mesaj = '✅ Şu an açık bekleyen siparişiniz bulunmuyor.';
                } else {
                    // Numaralı emoji listesi
                    const emojiler = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
                    mesaj = '📦 *Açık Siparişler*\n\n';
                    acik.forEach((s, i) => {
                        const em = emojiler[i] || `${i+1})`;
                        mesaj += `${em} ${s.SiparisNo}  |  ${(s.SiparisTarihi||'').substring(0,10)}\n`;
                    });
                    mesaj += '─────────────────\n';
                    mesaj += 'Detay için açık siparişin sıra numarasını yazınız.\n';
                    mesaj += '─────────────────\n';
                    mesaj += '0️⃣ Ana Menüye Dön';
                    // Listeyi session'a kaydet — numara yazınca detay açılsın
                    icdasSession.set(sender, { 
                        state: 'menu', 
                        acikSiparisler: acik,
                        acikMod: true,
                        timestamp: Date.now() 
                    });
                }
                break;
            }
            case '2': { // Kapalı Siparişler
                const vS = await icdasVeriCek('siparis', null, 500);
                const kapali = vS?.data?.siparis?.listeler?.sonTamamlanan || [];
                const ozet = vS?.data?.siparis?.ozet || {};
                mesaj = '✅ *Kapalı Sipariş Özeti*\n\n';
                mesaj += `Tamamlanan: ${ozet.tamamlandi || 0} sipariş\n`;
                mesaj += `İptal: ${ozet.iptal || 0} sipariş\n\n`;
                if (kapali.length) {
                    mesaj += '*Son Tamamlananlar:*\n';
                    kapali.slice(0,5).forEach(s => {
                        mesaj += `• ${s.SiparisNo} — ${(s.SiparisTarihi||'').substring(0,10)} — ${s.ToplamMiktar} adet\n`;
                    });
                }
                break;
            }
            case '3': { // Envanter Stok
                const vSt = await icdasVeriCek('stok', null, 500);
                const stokListe = vSt?.data?.stok?.listeler?.aktif || [];
                const ozet = vSt?.data?.stok?.ozet || {};
                mesaj = '📊 *Envanter / Stok Durumu*\n\n';
                mesaj += `Aktif Kart: ${ozet.aktifKart || 0}\n`;
                mesaj += `Toplam Kalan: ${ozet.toplamKalan || 0}\n`;
                mesaj += `Sıfır Stoklu: ${ozet.sifirStoklu || 0}\n\n`;
                const tekerler = stokListe.filter(s => (s.StokIsmi||'').toUpperCase().includes('TEKERLEK'));
                if (tekerler.length) {
                    mesaj += '*Tekerlek Stok Detayı:*\n';
                    tekerler.forEach(t => {
                        mesaj += `• ${t.StokIsmi}\n  Giriş: ${t.Giris||0} | Çıkış: ${t.Cikis||0} | Kalan: ${t.Kalan||0}\n`;
                    });
                }
                break;
            }
            case '4': { // İrsaliye
                const vI = await icdasVeriCek('irsaliye', null, 500);
                const ozet = vI?.data?.irsaliye?.ozet || {};
                const gidenler = vI?.data?.irsaliye?.listeler?.giden || [];
                const gelenler = vI?.data?.irsaliye?.listeler?.gelen || [];
                mesaj = '🚛 *İrsaliye Durumu*\n\n';
                mesaj += `Gelen: ${ozet.gelen || 0} irsaliye\n`;
                mesaj += `Giden: ${ozet.giden || 0} irsaliye\n`;
                mesaj += `Bu Ay Gelen: ${ozet.gelenBuAy || 0} | Giden: ${ozet.gidenBuAy || 0}\n\n`;
                if (gidenler.length) {
                    mesaj += '*Son Gönderimler:*\n';
                    gidenler.slice(0,5).forEach(i => {
                        mesaj += `• ${i.IrsaliyeNo} — ${(i.IrsaliyeTarihi||'').substring(0,10)} — ${i.ToplamMiktar} adet\n`;
                    });
                }
                if (gelenler.length) {
                    mesaj += '\n*Son Teslim Alımlar:*\n';
                    gelenler.slice(0,5).forEach(i => {
                        mesaj += `• ${i.IrsaliyeNo} — ${(i.IrsaliyeTarihi||'').substring(0,10)} — ${i.ToplamMiktar} adet\n`;
                    });
                }
                break;
            }
            case '5': { // Dolum Detay
                const vD = await icdasVeriCek('dolum', null, 500);
                const ozet = vD?.data?.dolum?.ozet || {};
                const devamEden = vD?.data?.dolum?.listeler?.devamEden || [];
                const tamamlanan = vD?.data?.dolum?.listeler?.sonTamamlanan || [];
                // Ebat bazlı say
                const ebatSayim = {};
                [...devamEden, ...tamamlanan].forEach(d => {
                    const ebat = (d.EbatKodu || d.EbatAdi || 'Bilinmeyen').trim();
                    if (!ebatSayim[ebat]) ebatSayim[ebat] = { devam: 0, tamam: 0 };
                    if (devamEden.includes(d)) ebatSayim[ebat].devam++;
                    else ebatSayim[ebat].tamam++;
                });
                mesaj = '🔧 *Tekerlek Dolum Detayı*\n\n';
                mesaj += `Toplam Aktif: ${ozet.toplamAktif || 0}\n`;
                mesaj += `Devam Eden: ${ozet.devamEden || 0}\n`;
                mesaj += `Tamamlanan: ${ozet.tamamlanan || 0}\n\n`;
                if (Object.keys(ebatSayim).length) {
                    mesaj += '*Ebat Bazlı Dağılım:*\n';
                    Object.entries(ebatSayim).forEach(([ebat, c]) => {
                        mesaj += `• ${ebat}: Devam ${c.devam} | Tamamlanan ${c.tamam}\n`;
                    });
                }
                if (devamEden.length) {
                    mesaj += '\n*Devam Eden Dolumlar:*\n';
                    devamEden.slice(0,5).forEach(d => {
                        mesaj += `• ${d.Kod} — ${d.EbatAdi} — ${d.DurumEtiket}\n`;
                    });
                }
                break;
            }
        }
    } catch(e) {
        console.error('İçdaş işlem hatası:', e.message);
        mesaj = 'Sisteme şu an ulaşamıyorum, lütfen tekrar deneyin.';
    }

    // case 1 kendi menüsünü zaten ekliyor, diğerleri için ekle
    if (!mesaj.includes('0️⃣ Ana Menüye Dön')) {
        mesaj += '\n─────────────────\n0️⃣ Ana Menüye Dön';
    }
    await whatsappGonder(sender, mesaj);
    // case 1 kendi session'ını zaten ayarladı — üzerine yazma
    const mevcutSes = icdasSession.get(sender) || {};
    if (!mevcutSes.acikMod) {
        icdasSession.set(sender, { state: 'menu', timestamp: Date.now() });
    }
    console.log(`✅ İçdaş seçim ${secim} işlendi -> ${sender}`);
}

async function fetchAllData() {
    const results = await Promise.allSettled(
        Object.entries(URLS).map(([key, url]) =>
            axios.get(url).then(r => ({
                key,
                data: parseCSV((key === 'makinalar' || key === 'makinalarEski') ? r.data.replace(/\r\n|\r/g, '\n').replace(/"([^"]*)"/g, (m, p1) => '"' + p1.replace(/\n/g, ' ') + '"') : r.data)
            }))
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
    const sinirli  = tamTablo ? kaynak.slice(0, 80) : kaynak.slice(0, 150);
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

function formatMakinaSatiri(emoji, model, makinaTipi, lastikInch, lastikMetrik, jantTipi) {
    // Model + Makina Tipi — ilk satır
    const ustSatir = [model, makinaTipi].filter(v => v && v.toString().trim()).join(' | ');
    // Lastik ölçüsü + Jant Tipi (kalın) — alt satır
    const olcu = [lastikInch, lastikMetrik].filter(v => v && v.toString().trim()).join(' | ');
    const jant = jantTipi ? `*${jantTipi.trim()}*` : '';
    const altSatir = [olcu, jant].filter(Boolean).join(' | ');
    return `${emoji} ${ustSatir}\n   ${altSatir}`;
}

function musteriFiltrele(data, cariAdi) {
    if (cariAdi === 'Bilinmeyen Musteri') return {};
    const cu = cariAdi.toUpperCase();

    // Erdemli Kauçuk yetkilileri tüm verileri görebilir
    const erdemliYetkili = cu.includes('ERDEMLİ KAUÇUK') || cu.includes('ERDEMLİ KAUCUK') || cu.includes('ERDEMLI KAUCUK') || cu.includes('ERDEMLI KAU');
    if (erdemliYetkili) {
        return {
            siparisler:     data.siparisler     || [],
            acikSiparisler: data.acikSiparisler || [],
            eksikJant:      data.eksikJant      || [],
            islemler:       data.islemler       || [],
            bakiye:         data.bakiye         || [],
        };
    }

    return {
        siparisler:     (data.siparisler     || []).filter(r => (r['Cari Adı'] || r['Cari Adi'] || '').toUpperCase().includes(cu)),
        acikSiparisler: (data.acikSiparisler || []).filter(r => (r['Cari Adı'] || r['Cari Adi'] || '').toUpperCase().includes(cu)),
        eksikJant:      (data.eksikJant      || []).filter(r => (r['Cari Adı'] || r['Cari Adi'] || '').toUpperCase().includes(cu)),
        islemler:       (data.islemler       || []).filter(r => (r['Frma'] || r['Firma'] || '').toUpperCase().includes(cu)),
        bakiye:         (data.bakiye         || []).filter(r => (r['Frma'] || '').toUpperCase().includes(cu)),
    };
}

function erdemliYetkiliMi(cariAdi) {
    const cu = (cariAdi || '').toUpperCase();
    return cu.includes('ERDEMLİ KAUÇUK') || cu.includes('ERDEMLİ KAUCUK') || cu.includes('ERDEMLI KAUCUK') || cu.includes('ERDEMLI KAU');
}

function mesajKonusuTespit(msg) {
    const m = msg.toUpperCase()
        .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G')
        .replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');
    return {
        fiyat:    /FIYAT|UCRET|DOLAR|USD|KAPLAMA|SIFIR JANT|NE KADAR|KACO/.test(m),
        siparis:  /SIPARIS|ORDER|TESLIM|KALAN|URETIM|ADET/.test(m),
        bakiye:   /BAKIYE|BORC|ODEME|FATURA|TAHSILAT|ISLEM/.test(m),
        teknik:   /HATA|ARIZA|ERROR|FAULT|BAKIM|HIDROLIK|AKU|SARJ|SENSOR|VOLTAJ|TEKNIK|KUMANDA/.test(m),
        polyfill: /POLYFILL|DOLUM|DOLDUR/.test(m),
        makina:   /MAKINA|PLATFORM|METRE|LAST[IUG]|TEKERLEK|HANGI LAST/.test(m),
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

        // WhatsApp grubuna bildirim gönder
        if (GRUP_ID) {
            const bildirim = `🤖 *RobERD'ten Mesaj Var!*

📅 Tarih: ${tarih}
👤 Müşteri: ${siparis.cariAdi}
📞 Telefon: ${siparis.telefon}
📦 Ürün: ${siparis.urunAdi}
💰 Fiyat: ${siparis.fiyat}
🔢 Adet: ${siparis.adet || 1}
📌 Kaynak: WhatsApp Bot`;

            await axios.post('https://api.fonnte.com/send', {
                target: GRUP_ID,
                message: bildirim,
                countryCode: '0'
            }, { headers: { 'Authorization': FONNTE_TOKEN } });
            console.log(`📢 Grup bildirimi gönderildi -> ${GRUP_ID}`);
        }

        return true;
    } catch (err) {
        console.error('Sheets yazma hatasi:', err.message);
        return false;
    }
}

function fiyatVarMi(metin) {
    // Hem USD/$ içeren normal fiyat hem de [URUN:|FIYAT:] tag'i ara
    // Sadece Gemini'nin eklediği tag varsa tetikle — çoklu ürün listelerinde tag eklenmez
    return /\[URUN:/i.test(metin);
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

// ═══════════════════════════════════════════════════════════════
// MENÜ METİNLERİ
// ═══════════════════════════════════════════════════════════════
const MENU_KAYITLI = `Size nasıl yardımcı olabilirim? 😊

1️⃣ Borç / Bakiye sorgulama
2️⃣ Lastik fiyatı öğrenme
3️⃣ Lastik siparişi verme
4️⃣ Şikayet / Öneri bildirimi
5️⃣ Teslim alınmayan jant bilgilendirme
6️⃣ Açık sipariş sorgulama
7️⃣ Ödeme & Fatura Bilgisi

Lütfen numarasını yazın.`;

const MENU_YENI = `Merhaba! Erdemli Kauçuk'a hoş geldiniz 👋

Size nasıl yardımcı olabilirim?

1️⃣ Yeni müşteri kaydı oluştur
2️⃣ Lastik fiyatı öğren
3️⃣ Lastik siparişi ver

📌 *Not:* Kayıtlı müşterilerimiz %5 RobERD indirimi ve özel fiyat avantajından yararlanır.

Lütfen numarasını yazın.`;

// İskonto kampanya bitiş tarihi: 08.04.2026
const KAMPANYA_BITIS = new Date('2026-04-08T00:00:00+03:00').getTime();

function iskontoluMu(siparis) {
    // Siparişin tarihi kampanya bitiş tarihinden önceyse %5 ekstra iskonto uygulanır
    const tarihKol = siparis['Kayıt Tarihi'] || siparis['Tarih'] || siparis['TARİH'] || '';
    if (!tarihKol) return false;
    const tarih = new Date(tarihKol).getTime();
    return !isNaN(tarih) && tarih < KAMPANYA_BITIS;
}

async function whatsappGonder(target, message) {
    return axios.post('https://api.fonnte.com/send', {
        target, message, countryCode: '0'
    }, { headers: { 'Authorization': FONNTE_TOKEN } });
}

// PDF dosyası WhatsApp'a gönder — Fonnte url parametresiyle
async function whatsappPdfGonder(target, pdfUrl, caption) {
    const payload = {
        target,
        url: pdfUrl,
        type: 'document',
        filename: 'siparis_detay.pdf',
        message: caption || '',
        countryCode: '0'
    };
    console.log('Fonnte PDF payload:', JSON.stringify(payload));
    const resp = await axios.post('https://api.fonnte.com/send', payload,
        { headers: { 'Authorization': FONNTE_TOKEN } }
    );
    console.log('Fonnte PDF response:', JSON.stringify(resp.data));
    return resp;
}



app.post('/webhook', async (req, res) => {
    res.status(200).send({ status: true });
    const sender  = req.body.sender;
    let message = req.body.message || req.body.text;
    if (!sender || !message) { console.log('Sender veya mesaj yok'); return; }

        // Grup mesajlarını tamamen yoksay — bot sadece bireysel mesajlara cevap verir
        if (req.body.isgroup || (sender && sender.includes('@g.us'))) {
            console.log(`🚫 Grup mesajı yoksayıldı -> ${sender}`);
            return;
        }

    try {
        console.log(`\n💬 ${sender} | ${message}`);

        // ═══════════════════════════════════════════════════════════════
        // MÜŞTERI TESPİTİ — Her akışta lazım
        // ═══════════════════════════════════════════════════════════════
        const dataErken = await fetchAllData();
        const senderCleanErken = cleanPhone(sender);
        const musteriErken = (dataErken.cariler || []).find(c => {
            const telefonlar = (c['TELEFON'] || '').split(',').map(t => cleanPhone(t.trim())).filter(Boolean);
            return telefonlar.includes(senderCleanErken);
        });
        const cariAdiErken = musteriErken ? (musteriErken['ÜNVANI 1'] || musteriErken['Cari Adı'] || '') : '';
        const kayitliMusteriErken = !!musteriErken && !!cariAdiErken;

        // Yetkili tespiti: hangi sıradaki telefon yazdıysa o sıradaki yetkili
        let yetkiliErken = '';
        if (musteriErken) {
            const telefonlar = (musteriErken['TELEFON'] || '').split(',').map(t => cleanPhone(t.trim())).filter(Boolean);
            const yetkiliAdlari = (musteriErken['YETKİLİ'] || musteriErken['Yetkili'] || '').split(',').map(y => y.trim()).filter(Boolean);
            const telIdx = telefonlar.indexOf(senderCleanErken);
            // Aynı sıradaki yetkili varsa onu al, yoksa ilkini al
            yetkiliErken = telIdx >= 0 && yetkiliAdlari[telIdx]
                ? yetkiliAdlari[telIdx]
                : (yetkiliAdlari[0] || '');
        }

        // ═══════════════════════════════════════════════════════════════
        // İÇDAŞ KONTROLÜ — Eğer İçdaş firmasıysa özel akışa yönlendir
        // ═══════════════════════════════════════════════════════════════
        console.log(`[Cari Tespit] sender: ${sender} | cariAdi: "${cariAdiErken}" | kayitli: ${kayitliMusteriErken}`);
        if (icdasMi(cariAdiErken)) {
            console.log('🏭 İÇDAŞ modu aktif!');
            await icdasCevapla(sender, message, yetkiliErken);
            return;
        }

        const session = siparisSession.get(sender);
        const msgNorm = message.trim().toUpperCase()
            .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G')
            .replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');

        // ═══════════════════════════════════════════════════════════════
        // MENÜ AKIŞI — İlk selamlama veya menü bekleniyor
        // ═══════════════════════════════════════════════════════════════
        const selamlama = /^(MERHABA|SELAM|SA|HEY|İYİ|IYI|GÜNAYD|GUNAYD|HOSGELDIN|HOSGELDI|AÇIN|ACIN|HI|HELLO|TEKRAR|YENİ|YENI)/i.test(message.trim()) ||
                          message.trim().length <= 8;

        // İlk mesaj veya selamlama → menü göster
        if (!session || session.state === null) {
            // Yeni kullanıcı (!session) veya selamlama → her durumda menü
            if (!session || selamlama) {
                // Menü göster — yetkili adıyla selamla, şirket adıyla değil
                const selamAdi = yetkiliErken
                    ? yetkiliErken.split(' ')[0]  // İlk isim (örn: "ÖMER ERDEMLI" → "ÖMER")
                    : (cariAdiErken ? cariAdiErken.split(' ')[0] : '');
                const selamStr = selamAdi ? ` ${selamAdi}` : '';

                const menu = kayitliMusteriErken
                    ? `Merhaba${selamStr}! 👋\n\n` + MENU_KAYITLI
                    : MENU_YENI;

                siparisSession.set(sender, {
                    state: 'awaiting_menu',
                    kayitli: kayitliMusteriErken,
                    cariAdi: cariAdiErken,
                    timestamp: Date.now(),
                });
                sessionKaydet(siparisSession);

                await whatsappGonder(sender, menu);
                console.log(`📋 Menü gönderildi -> ${sender} | kayıtlı: ${kayitliMusteriErken}`);
                return;
            }
        }

        // ─── MENÜ TRİGGER — Sorgu bitti, müşteri herhangi bir şey yazdı → menüyü sun ───
        if (session && session.state === 'awaiting_menu_trigger') {
            const menu = session.kayitli ? MENU_KAYITLI : MENU_YENI;
            siparisSession.set(sender, { ...session, state: 'awaiting_menu' });
            sessionKaydet(siparisSession);
            await whatsappGonder(sender, menu);
            return;
        }

        // ─── MENÜ SEÇİMİ ───
        if (session && session.state === 'awaiting_menu') {
            const secim = parseInt(message.trim());
            const kayitli = session.kayitli;

            // Sayı değilse — sessizce menüyü tekrar göster, ❓ ekleme
            if (isNaN(secim) || secim < 1) {
                const menu = kayitli ? MENU_KAYITLI : MENU_YENI;
                await whatsappGonder(sender, menu);
                return;
            }

            if (kayitli) {
                // KAYITLI MÜŞTERİ MENÜSÜ
                switch (secim) {
                    case 1: // Borç/Bakiye
                        siparisSession.set(sender, { ...session, state: 'awaiting_menu' });
                        sessionKaydet(siparisSession);
                        await whatsappGonder(sender, '🔍 Bakiye bilginizi sorguluyorum...');
                        message = 'bakiye borcum ne kadar';
                        break;
                    case 2: // Lastik fiyatı
                        {
                            const MARKALAR = ['DINGLI','ELS','GENIE','HAULOTTE','JLG','LGMG','MANTALL','SINOBOOM','SNORKEL','ZOOMLION'];
                            const emojiR = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
                            const markaStr = MARKALAR.map((m,i) => `${emojiR[i]} ${m}`).join('\n');
                            siparisSession.set(sender, { ...session, state: 'awaiting_marka', markaListesi: MARKALAR });
                            sessionKaydet(siparisSession);
                            await whatsappGonder(sender, `Makinenizin markasını seçin: 🔧\n\n${markaStr}\n\nNumarasını yazmanız yeterli.`);
                        }
                        return;
                    case 3: // Sipariş verme
                        {
                            const MARKALAR = ['DINGLI','ELS','GENIE','HAULOTTE','JLG','LGMG','MANTALL','SINOBOOM','SNORKEL','ZOOMLION'];
                            const emojiR = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
                            const markaStr = MARKALAR.map((m,i) => `${emojiR[i]} ${m}`).join('\n');
                            siparisSession.set(sender, { ...session, state: 'awaiting_marka', markaListesi: MARKALAR });
                            sessionKaydet(siparisSession);
                            await whatsappGonder(sender, `Sipariş için makinenizin markasını seçin: 🔧\n\n${markaStr}\n\nNumarasını yazmanız yeterli.`);
                        }
                        return;
                    case 4: // Şikayet/Öneri
                        siparisSession.set(sender, { ...session, state: 'awaiting_sikayet' });
                        sessionKaydet(siparisSession);
                        await whatsappGonder(sender, '📝 Şikayet veya önerinizi yazabilirsiniz, yöneticimize ileteceğim:');
                        return;
                    case 5: // Teslim alınmayan jant
                        siparisSession.set(sender, { ...session, state: 'awaiting_menu' });
                        sessionKaydet(siparisSession);
                        await whatsappGonder(sender, '🔍 Teslim alınmayan jant bilgilerinizi sorguluyorum...');
                        message = 'teslim alınmayan eksik jantlarım hangileri';
                        break;
                    case 6: // Açık sipariş
                        siparisSession.set(sender, { ...session, state: 'awaiting_menu' });
                        sessionKaydet(siparisSession);
                        await whatsappGonder(sender, '🔍 Açık siparişlerinizi sorguluyorum...');
                        message = 'açık siparişlerim hangileri kaç gündür bekliyor';
                        break;
                    case 7: // Ödeme & Fatura Bilgisi
                        siparisSession.set(sender, { ...session, state: 'awaiting_menu' });
                        sessionKaydet(siparisSession);
                        await whatsappGonder(sender, '🔍 Ödeme ve fatura bilgilerinizi sorguluyorum...');
                        message = 'ödeme fatura işlemlerim ne durumda son hareketlerim neler';
                        break;
                    default:
                        await whatsappGonder(sender, `❓ Lütfen 1-7 arasında bir numara yazın.\n\n${MENU_KAYITLI}`);
                        return;
                }
            } else {
                // YENİ MÜŞTERİ MENÜSÜ
                switch (secim) {
                    case 1: // Yeni kayıt
                        siparisSession.set(sender, { ...session, state: 'awaiting_kayit_firma' });
                        sessionKaydet(siparisSession);
                        await whatsappGonder(sender, '📋 *Müşteri Kayıt Formu*\n\nFirmanızın tam ticari unvanını yazar mısınız?');
                        return;
                    case 2: // Fiyat
                        {
                            const MARKALAR = ['DINGLI','ELS','GENIE','HAULOTTE','JLG','LGMG','MANTALL','SINOBOOM','SNORKEL','ZOOMLION'];
                            const emojiR = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
                            const markaStr = MARKALAR.map((m,i) => `${emojiR[i]} ${m}`).join('\n');
                            siparisSession.set(sender, { ...session, state: 'awaiting_marka', markaListesi: MARKALAR });
                            sessionKaydet(siparisSession);
                            await whatsappGonder(sender, `Makinenizin markasını seçin: 🔧\n\n${markaStr}\n\nNumarasını yazmanız yeterli.\n\n📌 Cari kaydı yaptırırsanız %5 indirimden yararlanabilirsiniz.`);
                        }
                        return;
                    case 3: // Sipariş
                        {
                            const MARKALAR = ['DINGLI','ELS','GENIE','HAULOTTE','JLG','LGMG','MANTALL','SINOBOOM','SNORKEL','ZOOMLION'];
                            const emojiR = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
                            const markaStr = MARKALAR.map((m,i) => `${emojiR[i]} ${m}`).join('\n');
                            siparisSession.set(sender, { ...session, state: 'awaiting_marka', markaListesi: MARKALAR });
                            sessionKaydet(siparisSession);
                            await whatsappGonder(sender, `Sipariş için makinenizin markasını seçin: 🔧\n\n${markaStr}\n\nNumarasını yazmanız yeterli.\n\n📌 Cari kaydı yaptırırsanız %5 indirimden yararlanabilirsiniz.`);
                        }
                        return;
                    default:
                        await whatsappGonder(sender, `❓ Lütfen 1-3 arasında bir numara yazın.\n\n${MENU_YENI}`);
                        return;
                }
            }
        }

        // ─── ŞİKAYET AKIŞI ───
        if (session && session.state === 'awaiting_sikayet') {
            if (GRUP_ID) {
                await whatsappGonder(GRUP_ID,
                    `📣 *Şikayet / Öneri Bildirimi*\n\n👤 Müşteri: ${session.cariAdi || 'Bilinmeyen'}\n📞 Tel: +${sender}\n\n💬 Mesaj:\n${message}`
                );
            }
            await whatsappGonder(sender, '✅ Şikayet / öneriniz alındı. Yöneticimize iletildi, en kısa sürede sizinle iletişime geçilecek. Teşekkürler! 🙏\n\nBaşka bir konuda yardımcı olabilir miyim? Bir şey yazın.');
            siparisSession.set(sender, { ...session, state: 'awaiting_menu_trigger' });
            sessionKaydet(siparisSession);
            return;
        }

        // ═══════════════════════════════════════════════════════════════
        // YENİ MÜŞTERİ KAYIT AKIŞI
        // ═══════════════════════════════════════════════════════════════
        if (session && session.state === 'awaiting_kayit_firma') {
            siparisSession.set(sender, { ...session, state: 'awaiting_kayit_adres', kayitFirma: message.trim() });
            sessionKaydet(siparisSession);
            await whatsappGonder(sender, '📍 Firmanızın adresini yazar mısınız?');
            return;
        }

        if (session && session.state === 'awaiting_kayit_adres') {
            siparisSession.set(sender, { ...session, state: 'awaiting_kayit_vd', kayitAdres: message.trim() });
            sessionKaydet(siparisSession);
            await whatsappGonder(sender, '🏛️ Vergi dairenizi yazar mısınız?');
            return;
        }

        if (session && session.state === 'awaiting_kayit_vd') {
            siparisSession.set(sender, { ...session, state: 'awaiting_kayit_vn', kayitVD: message.trim() });
            sessionKaydet(siparisSession);
            await whatsappGonder(sender, '🔢 Vergi numaranızı yazar mısınız?');
            return;
        }

        if (session && session.state === 'awaiting_kayit_vn') {
            const kayitBilgi = {
                firma:   session.kayitFirma || '—',
                adres:   session.kayitAdres || '—',
                vd:      session.kayitVD    || '—',
                vn:      message.trim(),
                telefon: sender,
            };
            siparisSession.delete(sender); sessionKaydet(siparisSession);

            // Gruba bildir
            if (GRUP_ID) {
                await whatsappGonder(GRUP_ID,
                    `🆕 *Yeni Müşteri Kayıt Talebi*\n\n🏢 Firma: ${kayitBilgi.firma}\n📍 Adres: ${kayitBilgi.adres}\n🏛️ Vergi Dairesi: ${kayitBilgi.vd}\n🔢 Vergi No: ${kayitBilgi.vn}\n📞 Tel: +${kayitBilgi.telefon}\n\n_RobERD üzerinden gelen kayıt talebi._`
                );
            }

            await whatsappGonder(sender,
                `✅ *Bilgileriniz alındı!*\n\n🏢 ${kayitBilgi.firma}\n📍 ${kayitBilgi.adres}\n🏛️ ${kayitBilgi.vd} / ${kayitBilgi.vn}\n\nYetkilimiz en kısa sürede kaydınızı oluşturup sizinle iletişime geçecek. 🙏\n\n📌 Kaydınız tamamlandıktan sonra *%5 RobERD indirimi* ve *özel müşteri fiyatı* avantajlarından yararlanabilirsiniz.`
            );
            return;
        }



        // AŞAMA 1.5: Müşteri model listesinden numara seçti
        if (session && session.state === 'awaiting_model') {
            const secimNo = parseInt(msgNorm) - 1;
            const detay = session.modelDetay && session.modelDetay[secimNo];

            if (!isNaN(secimNo) && secimNo >= 0 && detay) {
                const stokAdi = detay.stokAdi;
                console.log(`✅ Model seçildi: ${detay.model} | Stok: ${stokAdi}`);

                const data2 = await fetchAllData();

                // ── Müşteri tespiti
                const senderClean2 = cleanPhone(sender);
                const musteri2 = (data2.cariler || []).find(c => {
                    const telefonlar = (c['TELEFON'] || '').split(',').map(t => cleanPhone(t.trim())).filter(Boolean);
                    return telefonlar.includes(senderClean2);
                });
                const cariAdi2 = musteri2 ? (musteri2['ÜNVANI 1'] || musteri2['Cari Adı'] || '') : '';
                const kayitliMusteri = !!musteri2 && !!cariAdi2;

                // ── Liste fiyatını bul — tam eşleşme, sonra esnek eşleşme
                const fiyatSatiri = (data2.urunler || []).find(r => {
                    const tanim = (Object.values(r)[0] || '').trim();
                    return tanim === stokAdi || tanim.toLowerCase() === stokAdi.toLowerCase();
                }) || (data2.urunler || []).find(r => {
                    // Esnek eşleşme: stokAdi içindeki sayısal ölçü fiyat listesinde geçiyor mu?
                    const tanim = (Object.values(r)[0] || '').trim().toLowerCase();
                    const stokNorm2 = stokAdi.toLowerCase();
                    return tanim.includes(stokNorm2) || stokNorm2.includes(tanim);
                });

                const formatFiyat = (val) => {
                    if (!val || val.toString().trim() === '') return null;
                    const str = val.toString().trim();
                    if (str.includes('$') || str.toUpperCase().includes('USD')) return str;
                    return `$${str} USD`;
                };

                // %5 RobERD iskontosu — her zaman aktif
                const ISKONTO_ORAN = 0.05;
                const iskontoluFiyat = (fiyatStr) => {
                    if (!fiyatStr) return null;
                    const sayi = parseFloat(fiyatStr.replace(/[^0-9.,]/g, '').replace(',', '.'));
                    if (isNaN(sayi) || sayi === 0) return null;
                    const indirimli = (sayi * (1 - ISKONTO_ORAN)).toFixed(2);
                    return `$${indirimli} USD`;
                };
                const iskontoBilgisi = `\n\n🎁 *RobERD'den özel fiyat:* WhatsApp üzerinden sipariş verdiğiniz için *%5 indirim* uygulanmaktadır.`;

                let kaplamaFiyat = null, sifirJant = null, tekerTanim = stokAdi;
                if (fiyatSatiri) {
                    const kolonlar = Object.keys(fiyatSatiri);
                    tekerTanim   = fiyatSatiri[kolonlar[0]] || stokAdi;
                    kaplamaFiyat = formatFiyat(fiyatSatiri[kolonlar[1]]);
                    sifirJant    = formatFiyat(fiyatSatiri[kolonlar[2]]);
                }

                // ── Sipariş geçmişinde bu ürünü daha önce aldı mı?
                let eskiFiyat = null;
                if (kayitliMusteri) {
                    const cu = cariAdi2.toUpperCase()
                        .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G')
                        .replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');
                    const musteriSiparisler = (data2.siparisler || []).filter(r => {
                        const cari = (r['Cari Adı'] || r['Cari Adi'] || r['CARİ ADI'] || '').toUpperCase()
                            .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G')
                            .replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');
                        return cari.includes(cu) || cu.includes(cari);
                    });

                    const stokNorm = stokAdi.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const eslesen = musteriSiparisler.filter(r => {
                        const tekerKol = r['Tekerlek Tanımı'] || r['Tekerlek Tanimi'] || r['TEKERLEK'] || Object.values(r)[2] || '';
                        const tekerNorm = tekerKol.toLowerCase().replace(/[^a-z0-9]/g, '');
                        return tekerNorm && (tekerNorm.includes(stokNorm) || stokNorm.includes(tekerNorm));
                    });

                    if (eslesen.length > 0) {
                        const sonSiparis = eslesen[eslesen.length - 1];
                        const fiyatKol = sonSiparis['Anlaşılan Fiyat'] || sonSiparis['Anlasilan Fiyat'] ||
                                         sonSiparis['ANLAŞILAN FİYAT'] || sonSiparis['Fiyat'] || sonSiparis['FİYAT'] || '';
                        if (fiyatKol && fiyatKol.toString().trim()) {
                            eskiFiyat = formatFiyat(fiyatKol.toString().trim());
                            console.log(`💰 Önceki fiyat bulundu: ${eskiFiyat} | Ürün: ${stokAdi} | Müşteri: ${cariAdi2}`);
                        }
                    }
                }

                // ── Senaryoya göre mesaj ve akış belirle
                let fiyatMesaj, siparisSorusuGonder = true;

                if (eskiFiyat) {
                    // ✅ Daha önce bu üründen almış → önceki anlaşılan fiyat + %5
                    const eskiIndirimli = iskontoluFiyat(eskiFiyat);
                    fiyatMesaj = eskiIndirimli
                        ? `*${tekerTanim}* için daha önce anlaştığımız fiyat:\n\n💰 Liste fiyatı: ~~${eskiFiyat}~~\n🎁 *RobERD indirimi (%5):* *${eskiIndirimli}*\n\n_WhatsApp üzerinden sipariş verdiğiniz için %5 indirim uygulanmaktadır._`
                        : `*${tekerTanim}* için daha önce anlaştığımız fiyat:\n\n💰 *${eskiFiyat}*`;
                    kaplamaFiyat = eskiIndirimli || eskiFiyat;
                    sifirJant    = null;

                } else if (fiyatSatiri) {
                    // ✅ Fiyat listesinde var (daha önce almamış veya kayıtsız müşteri) → liste fiyatı + %5
                    const kapIndirimli   = iskontoluFiyat(kaplamaFiyat);
                    const sifirIndirimli = iskontoluFiyat(sifirJant);
                    fiyatMesaj = sifirJant
                        ? `*${tekerTanim}* fiyatlarımız:\n\n🔧 *Kaplama* (müşteri kendi jantını getirir):\n   ~~${kaplamaFiyat}~~ → *${kapIndirimli}*\n\n✨ *Sıfır Jant* (jant dahil):\n   ~~${sifirJant}~~ → *${sifirIndirimli}*${iskontoBilgisi}`
                        : `*${tekerTanim}* fiyatımız:\n\n💰 ~~${kaplamaFiyat}~~ → *${kapIndirimli}*${iskontoBilgisi}`;
                    kaplamaFiyat = kapIndirimli || kaplamaFiyat;
                    sifirJant    = sifirIndirimli || sifirJant;

                } else {
                    // ❌ Fiyat listesinde yok → kullanıcıya bildir ve menüye dön
                    console.log(`⚠️ Fiyat listesinde bulunamadı: ${stokAdi}`);
                    await whatsappGonder(sender,
                        `⚠️ *${stokAdi}* için fiyat bilgisi sistemde bulunamadı.\n\nYetkilimiz en kısa sürede sizinle iletişime geçecek. 📞\n\n_Başka bir konuda yardımcı olabilmem için bir şey yazın._`
                    );
                    const mevcutSesOnceki = siparisSession.get(sender) || {};
                    siparisSession.set(sender, {
                        ...mevcutSesOnceki,
                        state: 'awaiting_menu_trigger',
                        kayitli: kayitliMusteri,
                        cariAdi: cariAdi2,
                    });
                    sessionKaydet(siparisSession);
                    // Gruba bildir
                    if (GRUP_ID) {
                        await whatsappGonder(GRUP_ID,
                            `⚠️ *Fiyat Bulunamadı*\n\n👤 Müşteri: ${cariAdi2 || 'Bilinmeyen'}\n📞 Tel: +${sender}\n📦 Ürün: ${stokAdi}\n\n_Sistemde fiyat kaydı yok, müşteriyle iletişime geçilmeli._`
                        );
                    }
                    return;
                }

                // Fiyat mesajını gönder
                await axios.post('https://api.fonnte.com/send', {
                    target: sender, message: fiyatMesaj, countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });

                if (siparisSorusuGonder && !erdemliYetkiliMi(cariAdi2)) {
                    siparisSession.set(sender, {
                        state:        'awaiting_order',
                        cariAdi:      cariAdi2 || session.cariAdi || 'Müşteri',
                        telefon:      sender,
                        urunAdi:      tekerTanim,
                        fiyat:        kaplamaFiyat || '',
                        kaplamaFiyat: kaplamaFiyat || '',
                        sifirJant:    sifirJant    || '',
                        ciftOpsiyon:  !!(kaplamaFiyat && sifirJant),
                        timestamp:    Date.now(),
                    });
                    sessionKaydet(siparisSession);

                    setTimeout(async () => {
                        await axios.post('https://api.fonnte.com/send', {
                            target: sender,
                            message: '🛒 *Bu ürünü sipariş vermek ister misiniz?*\n\n1️⃣ Evet, sipariş ver\n2️⃣ Hayır, vazgeçtim\n\nLütfen *1* veya *2* yazın.',
                            countryCode: '0'
                        }, { headers: { 'Authorization': FONNTE_TOKEN } });
                        console.log(`🛒 Sipariş teklifi gönderildi -> ${sender} | ${tekerTanim}`);
                    }, 1500);
                } else {
                    siparisSession.delete(sender);
                    sessionKaydet(siparisSession);
                }
                return;

            } else {
                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: `❓ Lütfen listeden geçerli bir numara yazın (1-${(session.modelDetay || []).length}).`,
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                return;
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // KADEMELİ MAKİNA FİLTRELEME AKIŞI
        // Müşteri genel bir lastik/platform sorusu sorduğunda adım adım daralt:
        // Adım 1: Marka sor → Adım 2: Yükseklik sor → Adım 3: Model listesini sun
        // ═══════════════════════════════════════════════════════════════

        // Adım 1 yanıtı: Marka seçildi, şimdi yükseklik sor
        if (session && session.state === 'awaiting_marka') {
            const bilinen_markalar = ['DINGLI','GENIE','JLG','HAULOTTE','SKYJACK','SINOBOOM','LGMG','ZOOMLION','MANITOU','ELS','SNORKEL','MANTALL'];
            const secimNo = parseInt(msgNorm) - 1;
            let secilen_marka = null;

            // Numara ile seçim
            if (!isNaN(secimNo) && secimNo >= 0 && session.markaListesi && session.markaListesi[secimNo]) {
                secilen_marka = session.markaListesi[secimNo];
            }
            // Direkt marka adı yazdıysa
            else {
                secilen_marka = bilinen_markalar.find(m => msgNorm.includes(m));
                if (!secilen_marka && session.markaListesi) {
                    secilen_marka = session.markaListesi.find(m => msgNorm.includes(m.toUpperCase()));
                }
            }

            if (secilen_marka) {
                siparisSession.set(sender, { ...session, state: 'awaiting_yukseklik', secilenMarka: secilen_marka });
                sessionKaydet(siparisSession);

                // Bu marka için mevcut yükseklikleri bul — tüm kolonlarda marka ara
                const data2 = await fetchAllData();
                const yukseklikler = new Set();
                (data2.makinalar || []).forEach(r => {
                    const satirStr = Object.values(r).join(' ').toUpperCase()
                        .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G')
                        .replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');
                    if (satirStr.includes(secilen_marka)) {
                        // Yüksekliği makina tipi kolonundan çıkar (vals[2] genelde makina tipi)
                        const vals = Object.values(r);
                        const tip = (vals[2] || vals[1] || '');
                        const m = tip.match(/(\d{1,2})[,.]?\d*\s*m/i);
                        if (m) yukseklikler.add(parseInt(m[1]));
                    }
                });

                const emojiR = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
                const sirali = [...yukseklikler].sort((a,b)=>a-b);
                const yList = sirali.length > 0
                    ? sirali.map((y,i) => `${emojiR[i]||i+1+'.'} ${y} metre`).join('\n')
                    : null;

                const mesaj2 = yList
                    ? `*${secilen_marka}* için makinenizin çalışma yüksekliği nedir?\n\n${yList}\n\nNumarasını yazmanız yeterli. Ya da yüksekliği doğrudan yazabilirsiniz (örn: 8 metre).`
                    : `*${secilen_marka}* için makinenizin çalışma yüksekliğini yazın. (örn: 8 metre, 10 metre)`;

                siparisSession.set(sender, {
                    ...session,
                    state: 'awaiting_yukseklik',
                    secilenMarka: secilen_marka,
                    yukseklikListesi: sirali,
                });
                sessionKaydet(siparisSession);

                await axios.post('https://api.fonnte.com/send', {
                    target: sender, message: mesaj2, countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                console.log(`📋 Yükseklik sorusu gönderildi (${secilen_marka}) -> ${sender}`);
                return;
            } else {
                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: `❓ Listeden bir numara yazın ya da marka adını belirtin.\n\n${(session.markaListesi||[]).map((m,i)=>`${i+1}. ${m}`).join('\n')}`,
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                return;
            }
        }

        // Adım 2 yanıtı: Yükseklik seçildi, şimdi makina listesini sun
        if (session && session.state === 'awaiting_yukseklik') {
            const data2 = await fetchAllData();
            let yukseklik = null;

            // Numara ile seçim (listeden)
            const secimNo2 = parseInt(msgNorm) - 1;
            if (!isNaN(secimNo2) && secimNo2 >= 0 && session.yukseklikListesi && session.yukseklikListesi[secimNo2] !== undefined) {
                yukseklik = session.yukseklikListesi[secimNo2];
            }
            // Direkt sayı yazdıysa
            else {
                const yMatch = msgNorm.match(/(\d{1,2})/);
                if (yMatch) yukseklik = parseInt(yMatch[1]);
            }

            if (yukseklik) {
                const marka = session.secilenMarka;
                const eslesenMak = (data2.makinalar || []).filter(r => {
                    // Tüm kolonlarda marka ara (vals[0] her zaman marka olmayabilir)
                    const satirStr = Object.values(r).join(' ').toUpperCase()
                        .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G')
                        .replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');
                    const vals = Object.values(r);
                    const tipStr = (vals[2] || vals[1] || '');
                    const yOk = tipStr.includes(yukseklik + 'm') || tipStr.includes(yukseklik + ',') ||
                                tipStr.includes(yukseklik + '.') || new RegExp(`\\b${yukseklik}\\s*m`, 'i').test(tipStr);
                    return satirStr.includes(marka) && yOk;
                });

                if (eslesenMak.length === 0) {
                    await axios.post('https://api.fonnte.com/send', {
                        target: sender,
                        message: `⚠️ *${marka}* için *${yukseklik} metre* yükseklikte bir model bulunamadı.\n\nFarklı bir yükseklik deneyin ya da 0555 016 16 00'ı arayın.`,
                        countryCode: '0'
                    }, { headers: { 'Authorization': FONNTE_TOKEN } });
                    siparisSession.delete(sender); sessionKaydet(siparisSession);
                    return;
                }

                const emojiRakam = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
                const listeStr = eslesenMak.map((r, i) => {
                    const vals = Object.values(r);
                    return formatMakinaSatiri(emojiRakam[i]||`${i+1}.`, vals[1], vals[2], vals[3], vals[4], vals[5]);
                }).join('\n\n');

                const tamMesaj = `*${marka} — ${yukseklik} metre* için lastik seçenekleri:\n\n${listeStr}\n\nHangi modeli kullanıyorsunuz? Numarasını yazmanız yeterli.`;

                siparisSession.set(sender, {
                    ...session,
                    state: 'awaiting_model',
                    modelDetay: eslesenMak.map(r => ({
                        model:   Object.values(r)[1] || '',
                        stokAdi: Object.values(r)[6] || Object.values(r)[Object.values(r).length-1] || '',
                        tip:     Object.values(r)[5] || '',
                    }))
                });
                sessionKaydet(siparisSession);

                await axios.post('https://api.fonnte.com/send', {
                    target: sender, message: tamMesaj, countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                console.log(`📋 Model listesi gönderildi (${marka} ${yukseklik}m, ${eslesenMak.length} model) -> ${sender}`);
                return;
            } else {
                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: '❓ Makinenizin çalışma yüksekliğini yazın. Örn: *8* ya da *8 metre*',
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                return;
            }
        }

        // AŞAMA 2: Müşteri "EVET" veya "HAYIR" dedi (sipariş teklifi bekleniyor)
        if (session && session.state === 'awaiting_order') {
            if (msgNorm === '1' || msgNorm.includes('EVET') || msgNorm.includes('SİPARİŞ VER') || msgNorm.includes('SIPARIS VER')) {

                if (session.ciftOpsiyon) {
                    // Çift opsiyon — kaplama mı sıfır jant mı sor
                    const opsiyonMesaji =
`🔧 *Hangi seçeneği istersiniz?*

1️⃣ *Kaplama* — ${session.kaplamaFiyat}

2️⃣ *Sıfır Jantlı* — ${session.sifirJant}

*1* veya *2* yazın.`;

                    siparisSession.set(sender, { ...session, state: 'awaiting_option' }); sessionKaydet(siparisSession);

                    await axios.post('https://api.fonnte.com/send', {
                        target: sender,
                        message: opsiyonMesaji,

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

1️⃣ Onayla
2️⃣ İptal Et

Lütfen *1* veya *2* yazın.`;

                siparisSession.set(sender, { ...session, state: 'awaiting_adet' }); sessionKaydet(siparisSession);

                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: '📦 Kaç adet istiyorsunuz?\n\nSayıyı yazmanız yeterli.',
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });

                console.log(`📦 Adet sorusu gönderildi -> ${sender}`);
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

1️⃣ Onayla
2️⃣ İptal Et

Lütfen *1* veya *2* yazın.`;

                siparisSession.set(sender, {
                    ...session,
                    state: 'awaiting_adet',
                    fiyat: `${secim.tip} - ${secim.fiyat}`,
                }); sessionKaydet(siparisSession);

                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: '📦 Kaç adet istiyorsunuz?\n\nSayıyı yazmanız yeterli.',
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                console.log(`📦 Adet sorusu gönderildi (${secim.tip}) -> ${sender}`);
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

        // AŞAMA 2.7: Müşteri adet yazdı
        if (session && session.state === 'awaiting_adet') {
            const adet = parseInt(msgNorm);
            if (!isNaN(adet) && adet > 0 && adet <= 999) {
                // Adet geçerli — onay formunu göster
                const onayMesaji =
`📋 *SİPARİŞ ONAY FORMU*

👤 Müşteri: ${session.cariAdi}
📦 Ürün: ${session.urunAdi}
💰 Fiyat: ${session.fiyat}
🔢 Adet: ${adet}
📅 Tarih: ${new Date().toLocaleDateString('tr-TR')}

1️⃣ Onayla
2️⃣ İptal Et

Lütfen *1* veya *2* yazın.`;

                siparisSession.set(sender, { ...session, state: 'awaiting_confirm', adet }); sessionKaydet(siparisSession);

                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: onayMesaji,
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                console.log(`📋 Onay formu gönderildi (${adet} adet) -> ${sender}`);
                return;
            } else {
                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: '❓ Lütfen geçerli bir adet yazın. (örn: 1, 2, 4)',
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
                    adet:    session.adet || 1,
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

        // ═══ MAKİNA LİSTESİ KONTROLÜ — Prompt'a gitmeden önce yap ═══
        const msgU2 = message.toUpperCase()
            .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G')
            .replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');

        // Yükseklik tespiti
        const yukseklikBul = msgU2.match(/(\d{1,2})\s*(M\b|METRE|METER)/);

        // Marka tespiti — sadece sabit güvenilir listede ara (kelime sınırıyla)
        const markalarSabit = ['DINGLI','GENIE','JLG','HAULOTTE','SKYJACK','SINOBOOM','LGMG','ZOOMLION','MANITOU','ELS','AIRO','MERLO','MAGNI','NIFTYLIFT','TOUCAN','MULTITEL','SNORKEL','MANTALL'];
        let markaBul = markalarSabit.find(m => new RegExp(`\\b${m}\\b`).test(msgU2));

        // Lastik/makine sorusu mu? Tetikleyici kelimeler — msgU2 üzerinde çalıştır (normalleştirilmiş)
        const lastikSorusu = /LAST[IUG]|TEKERK|MAKA[SC]|PLATFORM|METRE|MAKINA|MACH|TIRES?|WHEEL/i.test(msgU2);

        // Marka tek başına yazılsa bile (örn: "Dingli lastiği") lastik sorusu sayılır
        const lastikAkisiBaslat = lastikSorusu || (markaBul && /LAST|TEKERLEK|KAPLAMA|SIFIR|JANT/i.test(msgU2));

        if (lastikAkisiBaslat && data.makinalar && data.makinalar.length > 0) {

            // ── Hem marka hem yükseklik varsa direkt filtrele (eski davranış) ──
            if (markaBul && yukseklikBul) {
                const filtrele = (liste) => liste.filter(r => {
                    const s = Object.values(r).join(' ').toUpperCase()
                        .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G')
                        .replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');
                    const mOk = s.includes(markaBul);
                    const yOk = s.includes(yukseklikBul[1]+'M');
                    return mOk && yOk;
                });

                let eslesenMak = filtrele(data.makinalar || []);

                if (eslesenMak.length > 0) {
                    const emojiRakam = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
                    const listeStr = eslesenMak.map((r, i) => {
                        const vals = Object.values(r);
                        return formatMakinaSatiri(emojiRakam[i]||`${i+1}.`, vals[1], vals[2], vals[3], vals[4], vals[5]);
                    }).join('\n\n');

                    const tamMesaj = `*${markaBul} — ${yukseklikBul[1]} metre* için lastik seçenekleri:\n\n${listeStr}\n\nHangi modeli kullanıyorsunuz? Numarasını yazmanız yeterli.`;

                    const mevcutSes = siparisSession.get(sender) || {};
                    siparisSession.set(sender, {
                        ...mevcutSes,
                        state: 'awaiting_model',
                        modelDetay: eslesenMak.map(r => ({
                            model:   Object.values(r)[1] || '',
                            stokAdi: Object.values(r)[6] || Object.values(r)[Object.values(r).length-1] || '',
                            tip:     Object.values(r)[5] || '',
                        }))
                    });
                    sessionKaydet(siparisSession);

                    await axios.post('https://api.fonnte.com/send', {
                        target: sender, message: tamMesaj, countryCode: '0'
                    }, { headers: { 'Authorization': FONNTE_TOKEN } });
                    console.log(`📋 Direkt model listesi gönderildi -> ${sender} (${eslesenMak.length} model)`);
                    return;
                }
            }

            // ── Sadece marka varsa yükseklik sor ──
            if (markaBul && !yukseklikBul) {
                const yukseklikler = new Set();
                (data.makinalar || []).forEach(r => {
                    const satirStr = Object.values(r).join(' ').toUpperCase()
                        .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G')
                        .replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');
                    if (satirStr.includes(markaBul)) {
                        const vals = Object.values(r);
                        const m = (vals[2] || vals[1] || '').match(/(\d{1,2})[,.]?\d*\s*m/i);
                        if (m) yukseklikler.add(parseInt(m[1]));
                    }
                });

                const emojiR = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
                const sirali = [...yukseklikler].sort((a,b)=>a-b);
                const yList = sirali.map((y,i) => `${emojiR[i]||i+1+'.'} ${y} metre`).join('\n');

                const mevcutSes = siparisSession.get(sender) || {};
                siparisSession.set(sender, {
                    ...mevcutSes,
                    state: 'awaiting_yukseklik',
                    secilenMarka: markaBul,
                    yukseklikListesi: sirali,
                });
                sessionKaydet(siparisSession);

                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: `*${markaBul}* için makinenizin çalışma yüksekliği nedir?\n\n${yList}\n\nNumarasını yazmanız yeterli.`,
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                console.log(`📋 Yükseklik sorusu gönderildi (marka biliniyor: ${markaBul}) -> ${sender}`);
                return;
            }

            // ── Ne marka ne yükseklik var — kademeli akışı başlat: önce marka sor ──
            if (!markaBul) {
                // Sabit marka listesi — makina rehberindeki ilk kolondan okumak hatalı sonuç verebilir
                const BILINEN_MARKALAR = ['DINGLI','ELS','GENIE','HAULOTTE','JLG','LGMG','MANTALL','SINOBOOM','SKYJACK','SNORKEL','ZOOMLION'];

                // Makina rehberinde gerçekten bulunan markaları filtrele
                const mevcutMarkalar = BILINEN_MARKALAR.filter(marka =>
                    (data.makinalar || []).some(r =>
                        Object.values(r).join(' ').toUpperCase()
                            .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G')
                            .replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C')
                            .includes(marka)
                    )
                );

                const markaListesi = mevcutMarkalar.length > 0 ? mevcutMarkalar : BILINEN_MARKALAR;
                const emojiR = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','1️⃣1️⃣','1️⃣2️⃣','1️⃣3️⃣','1️⃣4️⃣','1️⃣5️⃣'];
                const markaStr = markaListesi.map((m,i) => `${emojiR[i]||i+1+'.'} ${m}`).join('\n');

                const mevcutSes = siparisSession.get(sender) || {};
                siparisSession.set(sender, {
                    ...mevcutSes,
                    state: 'awaiting_marka',
                    markaListesi,
                });
                sessionKaydet(siparisSession);

                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: `Makinenizin markasını seçin: 🔧\n\n${markaStr}\n\nNumarasını yazmanız yeterli.`,
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                console.log(`📋 Marka sorusu gönderildi -> ${sender}`);
                return;
            }
        }
        // ═══════════════════════════════════════════════════════

        const musteri = (data.cariler || []).find(c => {
            const telefonlar = (c['TELEFON'] || '').split(',').map(t => cleanPhone(t.trim())).filter(Boolean);
            return telefonlar.includes(senderClean);
        });

        let cariAdi = 'Bilinmeyen Musteri';
        if (musteri) cariAdi = musteri['ÜNVANI 1'] || musteri['Cari Adı'] || 'Bilinmeyen Musteri';

        const mv = musteriFiltrele(data, cariAdi);
        const ilkMesaj = ilkMesajMi(sender);
        
        // Konu tespiti — sadece ilgili veriyi gönder
        const konu = mesajKonusuTespit(message);
        
        // Model seçimi yapıldıysa fiyat listesi her zaman gönderilmeli
        const sessionKonusu = siparisSession.get(sender);
        if (sessionKonusu && (sessionKonusu.state === 'awaiting_model' || sessionKonusu.secilenStokAdi)) {
            konu.fiyat = true;
        }
        // Sipariş akışındaysa sipariş verisi gönderilmeli
        if (sessionKonusu && ['awaiting_order','awaiting_option','awaiting_adet','awaiting_confirm'].includes(sessionKonusu.state)) {
            konu.siparis = true;
            konu.fiyat = true;
        }
        
        console.log('🎯 Konu:', JSON.stringify(konu));

        const polyfillSonuc = konu.polyfill ? polyfillAra(data.polyfill, message) : [];
        
        // Teknik bilgi: sadece teknik soru varsa gönder
        const teknikSonuc = konu.teknik 
            ? teknikBilgiAra(data.teknikBilgi, message)
            : { filtrelenmis: '', toplamSatir: 0, tamTablo: false };
        const teknikOzet = konu.teknik ? teknikBilgiOzet(data.teknikBilgi) : '';

        const prompt = `Sen "Erdemli Kauçuk - Ömer Erdemli" firmasının resmi WhatsApp yapay zeka asistanısın. Adın RobERD'dir.
Sana mesaj yazan: +${sender} | Sistemdeki Cari Adı: ${cariAdi} | Bu konuşmada ilk mesaj mı: ${ilkMesaj ? 'EVET' : 'HAYIR (tanıtım ve uyarıları tekrar etme)'}

GİZLİLİK KURALI: Aşağıdaki müşteriye özel veriler YALNIZCA ${cariAdi} firmasına aittir. Başka hiçbir firmanın bilgisini paylaşma.

${konu.teknik ? `━━━ TEKNİK BİLGİ TABANI ━━━
${teknikOzet}
${teknikSonuc.filtrelenmis ? `\nTeknik bilgiler:\n${teknikSonuc.filtrelenmis}` : '(Teknik bilgi yok)'}
Kullanım: KONU: AÇIKLAMA formatında. Teknik bilgi varsa doğrudan kullan, yetkiliye aktarma.` : '(Teknik soru değil — teknik tablo gönderilmedi)'}

${konu.fiyat || konu.makina ? `━━━ ÜRÜN FİYAT LİSTESİ ━━━
Sütunlar: Tekerlek Tanımı | kaplama (USD) | sıfır jant (USD)
kaplama=müşteri kendi jantını getirir, sıfır jant=jant dahil. USD birimi kullan.
${JSON.stringify(data.urunler || [])}` : '(Fiyat sorusu değil — fiyat listesi gönderilmedi)'}

${konu.polyfill ? `━━━ POLYFİLL ARAMA SONUCU ━━━
${JSON.stringify(polyfillSonuc)}` : ''}

━━━ MAKİNA - TEKERLEK REHBERİ ━━━
${(() => {
    const msgU = message.toUpperCase().replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G').replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');
    const markalar = ['DINGLI','GENIE','JLG','HAULOTTE','SKYJACK','SINOBOOM','LGMG','ZOOMLION','MANITOU','ELS'];
    const markaBulundu = markalar.find(m => msgU.includes(m));
    const yukseklikMatch = msgU.match(/(\d{1,2})\s*(M|METRE|METER)/);

    if (markaBulundu || yukseklikMatch) {
        const eslesen = (data.makinalar || []).filter(r => {
            const satirStr = Object.values(r).join(' ').toUpperCase()
                .replace(/İ/g,'I').replace(/Ş/g,'S').replace(/Ğ/g,'G').replace(/Ü/g,'U').replace(/Ö/g,'O').replace(/Ç/g,'C');
            const markaOk = markaBulundu ? satirStr.includes(markaBulundu) : true;
            const yukseklikOk = yukseklikMatch ? satirStr.includes(yukseklikMatch[1]+'M') : true;
            return markaOk && yukseklikOk;
        });

        if (eslesen.length > 0) {
            // Session'a model listesini kaydet
            const mevcut = siparisSession.get(sender) || {};
            const kolonlar = Object.keys(eslesen[0]);
            const modelKol = kolonlar.find(k => /model/i.test(k)) || kolonlar[1];
            const modelListesi = eslesen.map(r => Object.values(r).join(' | '));
            siparisSession.set(sender, { ...mevcut, modelListesi: eslesen.map(r => r[modelKol] || Object.values(r)[1]) });
            sessionKaydet(siparisSession);

            // Kolon adlarını bul
            const kolonAdlari = Object.keys(eslesen[0]);
            const tekerkolKol = kolonAdlari.find(k => /tekerlek.tan/i.test(k)) || kolonAdlari.find(k => /stok|urun|ürün/i.test(k)) || kolonAdlari[3];

            const emojiRakam = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
            // Sütun adları: Marka | Model | Makina Tipi | Lastik Ölçüsü Inch | Lastik Ölçüsü Metrik | JantTipi | STOK ADI
            const kolonlar2 = Object.keys(eslesen[0]);
            console.log('🔍 Makina kolonları:', kolonlar2.join(' | '));

            const markaKol  = kolonlar2[0];
            const modelKol2 = kolonlar2[1];
            const tipKol    = kolonlar2[2];
            const olcuInch  = kolonlar2[3];
            const olcuMetrik= kolonlar2[4];
            const jantTipi  = kolonlar2[5];
            const stokKol   = kolonlar2[6] || kolonlar2[kolonlar2.length-1];

            const liste = eslesen.map((r, i) => {
                const emoji = emojiRakam[i] || (i+1)+'.';
                return formatMakinaSatiri(emoji, r[modelKol2], r[tipKol], r[olcuInch], r[olcuMetrik], r[jantTipi]);
            }).join('\n');

            // Session'a STOK ADI ile kaydet
            const stokKol2  = stokKol;
            const modelKol3 = modelKol2;

            // Session'a STOK ADI ile kaydet — fiyat listesiyle eşleştirmek için
            const mevcut2 = siparisSession.get(sender) || {};
            siparisSession.set(sender, {
                ...mevcut2,
                modelListesi: eslesen.map(r => r[modelKol3] || Object.values(r)[1]),
                modelDetay: eslesen.map(r => ({
                    model:     r[modelKol3]  || Object.values(r)[1],
                    stokAdi:   r[stokKol2]   || Object.values(r)[Object.values(r).length-1] || '',
                    tip:       r[tipKol]     || '',
                }))
            });
            sessionKaydet(siparisSession);

            const baslik = `${markaBulundu || 'İlgili'} ${yukseklikMatch ? yukseklikMatch[1]+' metre ' : ''}platform için modellerimiz:`;
            return `[[DIREKT_GONDER]]${baslik}\n\n${liste}\n\nHangi modeli kullanıyorsunuz? Numarasını yazmanız yeterli.`;
        }
    }
    return (data.makinalar || []).map(r => Object.values(r).join(' | ')).join('\n');
})()}

${konu.siparis ? `━━━ ${cariAdi} - SİPARİŞ GEÇMİŞİ (son 20) ━━━
${JSON.stringify((mv.siparisler||[]).slice(-20))}

━━━ ${cariAdi} - AÇIK / BEKLEYEN SİPARİŞLER ━━━
${JSON.stringify(mv.acikSiparisler)}

━━━ ${cariAdi} - EKSİK JANT DURUMU ━━━
${JSON.stringify(mv.eksikJant)}` : '(Sipariş sorusu değil — sipariş verileri gönderilmedi)'}

${konu.bakiye ? `━━━ ${cariAdi} - FATURA / ÖDEME İŞLEMLERİ (son 30) ━━━
${JSON.stringify((mv.islemler||[]).slice(-30))}

━━━ ${cariAdi} - BORÇ BAKİYE DURUMU ━━━
${JSON.stringify(mv.bakiye)}` : '(Bakiye sorusu değil — finansal veriler gönderilmedi)'}

━━━ SEÇİLEN MODEL (Müşteri az önce listeden seçim yaptıysa) ━━━
${(() => {
    const ses = siparisSession.get(sender);
    if (ses && ses.secilenModel) {
        return `Müşteri seçti → Model: ${ses.secilenModel} | Stok Adı: ${ses.secilenStokAdi}\nBu stok adını fiyat listesinde bul, fiyatı ver ve sipariş teklifi yap.`;
    }
    return 'Henüz model seçimi yapılmadı';
})()}

━━━ SON LİSTELENEN MODELLER (Müşteri numara yazdıysa bu listeye göre eşleştir) ━━━
${(() => {
    const ses = siparisSession.get(sender);
    if (!ses) return 'Henüz model listesi sunulmadı';
    if (ses.modelDetay && ses.modelDetay.length > 0) {
        return ses.modelDetay.map((m, i) => `${i+1}. Model: ${m.model} | Stok Adı (fiyat listesiyle eşleşir): ${m.stokAdi} | Tip: ${m.tip}`).join('\n');
    }
    if (ses.modelListesi && ses.modelListesi.length > 0) {
        return ses.modelListesi.map((m, i) => `${i+1}. ${m}`).join('\n');
    }
    return 'Henüz model listesi sunulmadı';
})()}

━━━ MÜŞTERİNİN MESAJI ━━━
"${message}"

━━━ YANIT KURALLARI ━━━
1. KENDİNİ TANITMA: Sadece konuşmanın İLK mesajında "Ben RobERD, Erdemli Kauçuk'un yapay zeka asistanıyım" de. Sonraki mesajlarda asla tekrar etme.
1b. ERDEMLİ KAUÇUK YETKİLİSİ KURALI: Eğer Cari Adı "Erdemli Kauçuk" içeriyorsa bu kişi firma yetkilisidir. Tüm carilerin verilerini görebilir, sorgulayabilir. Ancak bu kişiye KESİNLİKLE sipariş teklifi yapma, "sipariş vermek ister misiniz?" SORMA.
2. KAYIT UYARISI: Sadece BİR KEZ ve yalnızca şüphe varsa "Sistemimizdeki kaydınızı şu an eşleştiremedim, detaylar için 0555 016 16 00" de. ASLA "kaydınız yok" veya "sisteme kayıtlı değilsiniz" gibi kesin ifadeler kullanma. Aynı konuşmada tekrar etme.
3. TEKNİK sorularda (hata kodu, makine özelliği, lastik ölçüsü, polyfill, makina-lastik uyumu, bakım bilgisi vb.) Teknik Bilgi Tabanını kullan. Bu bilgiler herkese verilebilir. TEKNİK BİLGİ TABANINDA CEVAP VARSA ONU KULLAN, yetkiliye aktarma.
4. MÜŞTERİYE ÖZEL sorularda (sipariş, bakiye, fiyat) YALNIZCA bu müşterinin verilerini kullan. Başka firma verisi ASLA paylaşma.
5. Borç/bakiye sorusunda: Toplam Bakiye, Vadesi Geçmiş Bakiye ve Vade Gün bilgilerini açıkça belirt.
5b. Fiyat sorusunda: Önce müşteriye özel "Anlaşılan Fiyat" sütununa bak. Yoksa fiyat listesindeki "kaplama" ve "sıfır jant" fiyatlarını AYRI AYRI göster. Her zaman USD birimi ile belirt. Örn: Kaplama: $65 USD | Sıfır Jant: $85 USD. Kaplama = müşteri kendi jantını getirir. Sıfır Jant = jant dahil fiyat.
5c. İSKONTO KURALI: Her fiyat gösteriminde mutlaka şunu belirt: "RobERD üzerinden sipariş verdiğiniz için liste fiyatına %5 indirim uygulanmaktadır." Liste fiyatını ve %5 indirimli fiyatı AYRI AYRI yaz. Örn: Liste: $65 USD → RobERD fiyatı: $61.75 USD (%5 indirimli).
6. Sipariş sorusunda: Sipariş adeti, teslim edilen, kalan ve anlaşılan fiyatı belirt.
7. Açık sipariş sorusunda: Kaç gündür beklediğini de söyle.
8. Polyfill/dolum sorusunda: Polyfill Arama Sonucunu kullan, ölçü formatı farklı olsa bile (x, -, /, virgül, nokta) aynı ölçü olarak değerlendir.
9. Cevap verilerde YOKSA (ne teknik bilgi ne müşteri verisi): "Yetkiliye aktarıyorum, en kısa sürede dönüş yapacaklar."
10. Bilinmeyen Müşteri ise: İlk mesajda yalnızca "Sistemimizdeki kaydınızı şu an eşleştiremedim, 0555 016 16 00 numaralı hattımızdan bizimle iletişime geçebilirsiniz" de ve soruyu yanıtla. Sonraki mesajlarda tekrar etme.
11. Her mesajın sonuna kayıt/uyarı ekleme. Doğal bir asistan gibi konuş.
12. Kısa, samimi ve profesyonel Türkçe kullan. Gereksiz uzatma yapma.
13. FİYAT VE MODEL TESPİT KURALI:

ADIM 1 — Müşterinin makine modeli net belli mi?
- Müşteri "Dingli 12 metre", "Genie 8 metre", "makaslı platform" gibi genel bir ifade kullandıysa → Model belirsizdir.
- Model belirsizse: Fiyat VERME, lastik ölçüsü VERME.
  Bunun yerine Makina-Tekerlek Rehberinden o marka/yükseklikle eşleşen TÜM satırları tara ve HEPSİNİ numaralandırarak listele.
  UYARI: Tablodan kaç satır eşleşiyorsa o kadar madde yaz — eksik bırakma, kendin ekleme, özetleme.
  Son olarak "Hangi modeli kullanıyorsunuz? Numarasını yazmanız yeterli." yaz.

ADIM 2 — Müşteri numara veya model adı yazdıysa → Model tespit edildi.
- SON LİSTELENEN MODELLER bölümündeki listeye göre seçilen modeli bul.
- SON LİSTELENEN MODELLER bölümünde seçilen modelin "Stok Adı" değerini bul.
- Bu "Stok Adı" değerini ÜRÜN FİYAT LİSTESİNDEKİ "Tekerlek Tanımı" kolonuyla birebir eşleştir.
- Eşleşen satırın kaplama ve sıfır jant fiyatlarını al.

EŞLEŞTIRME KURALI:
  → Makina rehberindeki "Stok Adı" = Fiyat listesindeki "Tekerlek Tanımı"
  → Birebir aynı isimle eşleştir. Bulamazsan en yakın ölçü/isim eşleşmesini kullan.

- Fiyatı bulduktan sonra yanıtın EN SONUNA tag ekle:
  * Hem kaplama hem sıfır jant varsa: [URUN:Stok Adı değeri|KAPLAMA:kaplama fiyatı|SIFIRJANT:sıfır jant fiyatı]
    Örnek: [URUN:15x5 Tekerlek (Dingli HA)|KAPLAMA:$65 USD|SIFIRJANT:$95 USD]
  * Tek fiyat varsa: [URUN:Tekerlek Tanımı değeri|FIYAT:fiyat]

- BİRDEN FAZLA ÜRÜN listelendiyse: KESİNLİKLE tag EKLEME.`;

        console.log('🧠 RobERD düşünüyor...');
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

        // Retry mekanizması — 429 hatasında bekle ve tekrar dene
        let result, aiResponse;
        for (let deneme = 1; deneme <= 3; deneme++) {
            try {
                result = await model.generateContent(prompt);
                aiResponse = result.response.text();
                break;
            } catch (e) {
                if (e.message && e.message.includes('429') && deneme < 3) {
                    const bekle = deneme * 15000; // 15s, 30s
                    console.log(`⏳ Rate limit, ${bekle/1000}sn bekleniyor (deneme ${deneme}/3)...`);
                    await new Promise(r => setTimeout(r, bekle));
                } else throw e;
            }
        }
        console.log('✅ RobERD yanıtladı:', aiResponse);

        // Tag'i müşteriye göstermeden önce temizle
        const temizMesaj = temizleYanit(aiResponse);

        // Direkt gönderilecek liste mesajı mı?
        const gonderilecekMesaj = temizMesaj.startsWith('[[DIREKT_GONDER]]')
            ? temizMesaj.replace('[[DIREKT_GONDER]]', '')
            : temizMesaj;

        await axios.post('https://api.fonnte.com/send', {
            target: sender,
            message: gonderilecekMesaj,
            countryCode: '0'
        }, { headers: { 'Authorization': FONNTE_TOKEN } });
        console.log(`🚀 GÖNDERİLDİ -> ${sender}`);

        // ─── Model listesi çıkarıldıysa session'a kaydet ───
        const modelListesiMatch = temizMesaj.match(/1️⃣[\s\S]*?(?=Hangi modeli|$)/);
        if (modelListesiMatch) {
            const satirlar = temizMesaj.split('\n');
            const modeller = [];
            satirlar.forEach(s => {
                const m = s.match(/^\s*\d+[.️⃣]\s*(?:Dingli|Genie|JLG|Haulotte|Skyjack|Sinoboom|LGMG|Zoomlion|ELS)?\s*([A-Z0-9\-+]+)/i);
                if (m) modeller.push(m[1].trim());
            });
            if (modeller.length > 0) {
                const mevcut = siparisSession.get(sender) || {};
                siparisSession.set(sender, { ...mevcut, modelListesi: modeller });
                sessionKaydet(siparisSession);
                console.log(`📋 Model listesi kaydedildi: ${modeller.join(', ')}`);
            }
        }

        // ─── AŞAMA 1: Bot fiyat verdiyse sipariş teklifi gönder ───
        if (fiyatVarMi(aiResponse) && !aiResponse.includes('[[DIREKT_GONDER]]') && !erdemliYetkiliMi(cariAdi)) {
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
            setTimeout(async () => {
                await axios.post('https://api.fonnte.com/send', {
                    target: sender,
                    message: '🛒 *Bu ürünü sipariş vermek ister misiniz?*\n\n1️⃣ Evet, sipariş ver\n2️⃣ Hayır, vazgeçtim\n\nLütfen *1* veya *2* yazın.',
                    countryCode: '0'
                }, { headers: { 'Authorization': FONNTE_TOKEN } });
                console.log(`🛒 Sipariş teklifi gönderildi -> ${sender} | Ürün: ${bilgi.urunAdi} | Fiyat: ${bilgi.fiyat || bilgi.kaplamaFiyat}`);
            }, 1500);
        } else {
            // Fiyat teklifi yoksa — state awaiting_menu ise bir sonraki mesajda menü gösterilecek
            const sessonrasi = siparisSession.get(sender);
            if (sessonrasi && sessonrasi.state === 'awaiting_menu' && sessonrasi.kayitli !== undefined) {
                // State'i trigger'a çevir — müşteri herhangi bir şey yazınca menü gelecek
                siparisSession.set(sender, { ...sessonrasi, state: 'awaiting_menu_trigger' });
                sessionKaydet(siparisSession);
            }
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
