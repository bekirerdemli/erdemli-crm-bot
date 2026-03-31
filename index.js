require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- TEŞHİS MODU: GELEN HER İSTEĞİ YAZDIRIR ---
app.use((req, res, next) => {
    console.log(`\n[${new Date().toLocaleTimeString()}] SİSTEME İSTEK GELDİ: ${req.method} ${req.path}`);
    if (req.method === 'POST') {
        console.log('GELEN VERİ (BODY):', req.body);
    }
    next();
});

// Fonnte'nin URL doğrulaması için GET metodu
app.get('/webhook', (req, res) => {
    res.status(200).send("Webhook aktif ve calisiyor");
});

// --- API ve Token Ayarları ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const FONNTE_TOKEN = process.env.FONNTE_TOKEN;

const URL_CARILER = 'https://docs.google.com/spreadsheets/d/1IeQ3BUb4BBmXETJ_wZ0agT1DW9LpYhtc3kR-9hDNY8M/export?format=csv&gid=1423089940';
const URL_URUNLER = 'https://docs.google.com/spreadsheets/d/1IeQ3BUb4BBmXETJ_wZ0agT1DW9LpYhtc3kR-9hDNY8M/export?format=csv&gid=1263788777';
const URL_ISLEMLER = 'https://docs.google.com/spreadsheets/d/1aHKb7lv6sei2ExnIB5Li0pEtygRo3hWLxTJGiHbda0g/export?format=csv&gid=1884664027';

// --- Dahili CSV Ayrıştırıcı ---
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
    const result = [];
    let cur = '', inQ = false;
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
    const [resCariler, resUrunler, resIslemler] = await Promise.all([
        axios.get(URL_CARILER),
        axios.get(URL_URUNLER),
        axios.get(URL_ISLEMLER)
    ]);
    return {
        cariler: parseCSV(resCariler.data),
        urunler: parseCSV(resUrunler.data),
        islemler: parseCSV(resIslemler.data)
    };
}

function cleanPhone(phone) {
    if (!phone) return "";
    let p = String(phone).replace(/[^0-9]/g, '');
    // 12 haneden uzunsa (ornegin 62905... -> 14 hane) son 12 haneyi al
    if (p.length > 12) p = p.slice(-12);
    // 0 ile basliyorsa 90 ekle
    if (p.startsWith('0')) p = '90' + p.substring(1);
    // Hala 90 ile baslamiyorsa basa 90 ekle
    if (!p.startsWith('90')) p = '90' + p;
    return p;
}

// --- Fonnte Webhook Dinleyici ---
app.post('/webhook', async (req, res) => {
    res.status(200).send({ status: true }); // Fonnte'ye anında "aldım" diyoruz

    // Fonnte bazen 'message' yerine 'text' kullanabilir, ikisine de bakalım
    const sender = req.body.sender;
    const message = req.body.message || req.body.text;

    if (!sender || !message) {
        console.log("⚠️ UYARI: Gönderen numarası veya mesaj metni bulunamadı. (Sistem mesajı olabilir)");
        return;
    }

    try {
        console.log(`\n💬 İŞLEME ALINIYOR -> Numara: ${sender} | Mesaj: ${message}`);

        const { cariler, urunler, islemler } = await fetchAllData();
        const senderClean = cleanPhone(sender);
        let cariAdi = "Bilinmeyen Müşteri";
        
        const musteri = cariler.find(c => cleanPhone(c['TELEFON'] || '') === senderClean);
        if (musteri) {
            cariAdi = musteri['ÜNVANI 1'] || musteri['Cari Adı'] || "Bilinmeyen Müşteri";
        }

        const musteriIslemleri = islemler.filter(islem => {
            const islemFirma = islem['Frma'] || islem['Firma'] || '';
            return cariAdi !== "Bilinmeyen Müşteri" && islemFirma.toUpperCase().includes(cariAdi.toUpperCase());
        });

        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // Pro yerine daha hızlı olan flash modeline geçtik

        const prompt = `Sen "Erdemli Kauçuk - Ömer Erdemli" firmasının resmi WhatsApp yapay zeka müşteri temsilcisisin.
        Şu an sana mesaj yazan numara: +${sender}
        Veritabanımızdaki Cari Adı: ${cariAdi}

        BİZİM SATTIĞIMIZ LASTİKLER VE FİYATLARI:
        ${JSON.stringify(urunler.slice(0, 50))}

        MÜŞTERİNİN KENDİ GEÇMİŞ İŞLEMLERİ (Ödemeler, faturalar, alınan lastikler):
        ${JSON.stringify(musteriIslemleri)}

        Müşterinin Mesajı: "${message}"

        KURALLAR:
        1. Sadece "LASTİKLER VE FİYATLARI" ve "GEÇMİŞ İŞLEMLERİ" listelerine bakarak cevap ver.
        2. Müşteri faturasını veya bakiyesini sorarsa sadece onun verisine bak. Başkasına bilgi verme.
        3. Sorunun cevabı verilerde YOKSA, SADECE şunu söyle: "Yetkiliye aktarıyorum, size en kısa zamanda dönüş yapacaklar."
        4. Kısa, samimi ve net bir profesyonel dil kullan.`;

        console.log("🧠 Yapay Zeka düşünülüyor...");
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();
        console.log("✅ Yapay Zeka Cevabı Üretti:", aiResponse);

        await axios.post('https://api.fonnte.com/send', {
            target: sender,
            message: aiResponse,
            countryCode: '0'
        }, {
            headers: { 'Authorization': FONNTE_TOKEN }
        });

        console.log(`🚀 CEVAP GÖNDERİLDİ -> ${sender}`);

    } catch (error) {
        console.error("❌ Bot çalışma hatası:", error.message || error);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Erdemli CRM Bot ${PORT} portunda başarıyla çalışıyor.`));
