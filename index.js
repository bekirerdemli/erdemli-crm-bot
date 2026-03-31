require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
    console.log(`\n[${new Date().toLocaleTimeString()}] SİSTEME İSTEK GELDİ: ${req.method} ${req.path}`);
    if (req.method === 'POST') console.log('GELEN VERİ (BODY):', req.body);
    next();
});

app.get('/webhook', (req, res) => res.status(200).send("Webhook aktif ve calisiyor"));

app.get('/modeller', async (req, res) => {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
        const r = await axios.get(url);
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
    islemler:       `https://docs.google.com/spreadsheets/d/${IID}/export?format=csv&gid=1884664027`,
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
        else data[r.value?.key || 'hata'] = [];
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

// Lastik ölçüsünü normalize et: 10x16,5 / 10-16.5 / 10/16.5 hepsi aynı
function normalizeOlcu(str) {
    if (!str) return '';
    return String(str)
        .replace(/[xX\/\-\s]/g, '.')
        .replace(/,/g, '.')
        .trim()
        .toLowerCase();
}

// Polyfill tablosunda lastik ölçüsüne göre ara
function polyfillAra(polyfillData, aranan) {
    const arananNorm = normalizeOlcu(aranan);
    if (!arananNorm) return [];
    
    // Önce tam eşleşme dene
    let bulunan = (polyfillData || []).filter(r => {
        const lastik = normalizeOlcu(r['Lastik Olcusu'] || r['Lastik Ölçüsü'] || '');
        const jant   = normalizeOlcu(r['Jant Olcusu']  || r['Jant Ölçüsü']   || '');
        return lastik === arananNorm || jant === arananNorm;
    });
    
    // Tam eşleşme yoksa içinde geçen var mı diye bak
    if (!bulunan.length) {
        bulunan = (polyfillData || []).filter(r => {
            const lastik = normalizeOlcu(r['Lastik Olcusu'] || r['Lastik Ölçüsü'] || '');
            const jant   = normalizeOlcu(r['Jant Olcusu']  || r['Jant Ölçüsü']   || '');
            return lastik.includes(arananNorm) || arananNorm.includes(lastik) ||
                   jant.includes(arananNorm)   || arananNorm.includes(jant);
        });
    }
    return bulunan;
}

function musteriFiltrele(data, cariAdi) {
    if (cariAdi === 'Bilinmeyen Musteri') return {};
    const cu = cariAdi.toUpperCase();
    return {
        siparisler:     (data.siparisler     || []).filter(r => (r['Cari Adi']  || '').toUpperCase().includes(cu)),
        acikSiparisler: (data.acikSiparisler || []).filter(r => (r['Cari Adi']  || '').toUpperCase().includes(cu)),
        eksikJant:      (data.eksikJant      || []).filter(r => (r['Cari Adi']  || '').toUpperCase().includes(cu)),
        islemler:       (data.islemler       || []).filter(r => (r['Frma'] || r['Firma'] || '').toUpperCase().includes(cu)),
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

        const musteri = (data.cariler || []).find(c => cleanPhone(c['TELEFON'] || '') === senderClean);
        let cariAdi = 'Bilinmeyen Musteri';
        if (musteri) cariAdi = musteri['UNVANI 1'] || musteri['Cari Adi'] || 'Bilinmeyen Musteri';

        const mv = musteriFiltrele(data, cariAdi);

        // Mesajdan olcu araması yap
        const polyfillSonuc = polyfillAra(data.polyfill, message);
        
        const prompt = `Sen "Erdemli Kaucuk - Omer Erdemli" firmasinin resmi WhatsApp yapay zeka asistanisin.
Sana mesaj yazan: +${sender} | Sistemdeki Cari Adi: ${cariAdi}

GIZLILIK: Asagidaki veriler YALNIZCA ${cariAdi} firmasina aittir. Baska hicbir firmanin bilgisini paylasma.

URUN FIYAT LISTESI:
${JSON.stringify(data.urunler || [])}

${cariAdi} - SIPARIS GECMISI:
Sutunlar: ID | Kayit Tarihi | Cari Adi | Uretim Modeli | Islem Tipi | Siparis Adeti |
Jant Teslim Alma Tarihi | Jant Teslim Alma | Jant Kontrol | Teslim Etme Tarihi |
Teslim Edilen | Kalan | Uretim Sayisi | Tekerlek Tanimi | Anlasilan Fiyat | Aciklama
${JSON.stringify(mv.siparisler)}

${cariAdi} - ACIK BEKLEYEN SIPARISLER:
Sutunlar: ID | Tekerlek Tanimi | Cari Adi | Kayit Tarihi | Jant Teslim Alma Tarihi | Uretim Sayisi | Gecen Gun Sayisi | Sehir
${JSON.stringify(mv.acikSiparisler)}

${cariAdi} - EKSIK JANT DURUMU:
Sutunlar: Cari Adi | ID | Tekerlek Tanimi | Kayit Tarihi | Jant Kontrol | Alinacak Jant | Gecen Gun Sayisi | Sehir
${JSON.stringify(mv.eksikJant)}

${cariAdi} - FATURA / ODEME ISLEMLERI:
${JSON.stringify(mv.islemler)}

MAKINA - TEKERLEK REHBERI (Genel bilgi):
${JSON.stringify(data.makinalar || [])}

POLYFILL DOLUM TABLOSU (Genel bilgi - ${(data.polyfill||[]).length} kayit mevcut):
Kullanicinin mesajinda gecen olculer icin arama yapildi:
${JSON.stringify(polyfillSonuc)}
Tam liste istersen yetkiliye sor diyebilirsin.

MUSTERININ MESAJI: "${message}"

FORMAT NORMALIZASYON - Kullanici lastik olcusu yazarken farkli ayiraclar kullanabilir:
- "10x16,5" = "10-16.5" = "10/16.5" = "10 16.5" hepsi ayni olcudur
- Nokta ve virgul esit: "16,5" = "16.5"
- Arama yaparken bu farklilikları goz ardi et, anlam olarak eslesmeye calis

YANIT KURALLARI:
1. YALNIZCA ${cariAdi} firmasinin verilerini kullan. Baska firma verisi ASLA paylasma.
2. Siparis durumu: siparis adeti, teslim edilen, kalan ve anlasilan fiyata bak.
3. Acik siparis sorusunda: Acik Siparisler tablosuna bak, kac gundir beklemis bilgisini de ver.
4. Eksik jant sorusunda: Eksik Jant tablosuna bak.
5. Fiyat sorusunda: once bu musteriye ozel Anlasilan Fiyat sutununa bak, yoksa genel fiyat listesini kullan.
6. Makina veya polyfill sorulari genel bilgidir, herkese verebilirsin.
7. Bakiye/borc sorusunda: Fatura/Odeme Islemleri tablosuna bak ve ozet ver.
8. Cevapta veri YOKSA: "Yetkiliye aktariyorum, en kisa surede donus yapacaklar."
9. Bilinmeyen Musteri ise: "Sisteminizde kaydinizi bulamadim, yetkili ile iletisime geciniz: 0555 016 16 00"
10. Kisa, samimi ve profesyonel Turkce kullan.`;

        console.log('🧠 Yapay Zeka dusunuyor...');
        const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();
        console.log('✅ Cevap:', aiResponse);

        await axios.post('https://api.fonnte.com/send', {
            target: sender,
            message: aiResponse,
            countryCode: '0'
        }, { headers: { 'Authorization': FONNTE_TOKEN } });

        console.log(`🚀 GONDERILDI -> ${sender}`);

    } catch (error) {
        console.error('❌ Hata:', error.message || error);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Erdemli CRM Bot ${PORT} portunda basariyla calisiyor.`));
