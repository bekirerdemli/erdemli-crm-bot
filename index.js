require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser'); // Sizin paketiniz eklendi
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
// body-parser ayarları
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- API ve Token Ayarları ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const FONNTE_TOKEN = process.env.FONNTE_TOKEN;

// --- Google Sheets CSV Linkleri ---
const URL_CARILER = 'https://docs.google.com/spreadsheets/d/1IeQ3BUb4BBmXETJ_wZ0agT1DW9LpYhtc3kR-9hDNY8M/export?format=csv&gid=1423089940';
const URL_URUNLER = 'https://docs.google.com/spreadsheets/d/1IeQ3BUb4BBmXETJ_wZ0agT1DW9LpYhtc3kR-9hDNY8M/export?format=csv&gid=1263788777';
const URL_ISLEMLER = 'https://docs.google.com/spreadsheets/d/1aHKb7lv6sei2ExnIB5Li0pEtygRo3hWLxTJGiHbda0g/export?format=csv&gid=1884664027';

// --- Dahili CSV Ayrıştırıcı ---
// (Ekstra kütüphane gerektirmemesi için sizin fatura.html yapınız kullanıldı)
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

// Google Sheets Verilerini Topluca Çekme
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

// Telefon Numarasını Temizleme (0532... -> 90532... formatı için)
function cleanPhone(phone) {
    let p = String(phone).replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = p.substring(1);
    if (!p.startsWith('90')) p = '90' + p;
    return p;
}

// --- Fonnte Webhook Dinleyici ---
app.post('/webhook', async (req, res) => {
    // Fonnte'nin mesajı tekrar tekrar göndermemesi için HTTP 200 OK yanıtını hemen dönüyoruz.
    res.status(200).send({ status: true });

    const { sender, message } = req.body;
    if (!message || !sender) return;

    try {
        console.log(`[Yeni Mesaj] Numara: ${sender} | Mesaj: ${message}`);

        // 1. Tablolardan verileri çek
        const { cariler, urunler, islemler } = await fetchAllData();

        // 2. Mesaj atan müşteriyi carilerde bul
        const senderClean = cleanPhone(sender);
        let cariAdi = "Bilinmeyen Müşteri";
        
        const musteri = cariler.find(c => cleanPhone(c['TELEFON'] || '') === senderClean);
        if (musteri) {
            cariAdi = musteri['ÜNVANI 1'] || musteri['Cari Adı'] || "Bilinmeyen Müşteri";
        }

        // 3. Sadece o müşteriye ait geçmiş işlemleri filtrele (Güvenlik)
        const musteriIslemleri = islemler.filter(islem => {
            const islemFirma = islem['Frma'] || islem['Firma'] || '';
            return cariAdi !== "Bilinmeyen Müşteri" && islemFirma.toUpperCase().includes(cariAdi.toUpperCase());
        });

        // 4. Eski @google/generative-ai sürümü için gemini-pro modeli kullanıyoruz
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });

        // 5. Yapay Zeka Talimatı (Prompt)
        const prompt = `Sen "Erdemli Kauçuk - Ömer Erdemli" firmasının resmi WhatsApp yapay zeka müşteri temsilcisisin.
        Şu an sana mesaj yazan numara: +${sender}
        Veritabanımızdaki Cari Adı: ${cariAdi}

        BİZİM SATTIĞIMIZ LASTİKLER VE FİYATLARI:
        ${JSON.stringify(urunler.slice(0, 50))}

        MÜŞTERİNİN KENDİ GEÇMİŞ İŞLEMLERİ (Ödemeler, faturalar, alınan lastikler):
        ${JSON.stringify(musteriIslemleri)}

        Müşterinin Mesajı: "${message}"

        KURALLAR (Bunlara Kesinlikle Uy):
        1. Sadece yukarıda sana verdiğim "LASTİKLER VE FİYATLARI" ve "GEÇMİŞ İŞLEMLERİ" listelerine bakarak cevap ver.
        2. Müşteri hesabını, faturasını veya bakiyesini sorarsa sadece onun verisine bak. Başka bir firmanın bilgisini ASLA paylaşma.
        3. Sorunun cevabı verilerde YOKSA, durumu anlayamadıysan veya özel bir pazarlık yapılıyorsa hiçbir bilgi uydurma. SADECE şunu söyle: "Yetkiliye aktarıyorum, size en kısa zamanda dönüş yapacaklar."
        4. Kısa, samimi ve net bir profesyonel dil kullan.`;

        // 6. Gemini'den cevabı al
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();

        // 7. Fonnte üzerinden müşteriye cevabı gönder
        await axios.post('https://api.fonnte.com/send', {
            target: sender,
            message: aiResponse,
            countryCode: '90'
        }, {
            headers: { 'Authorization': FONNTE_TOKEN }
        });

        console.log(`[Cevaplandı] -> ${sender}`);

    } catch (error) {
        console.error("Bot çalışma hatası:", error);
    }
});

// Sunucuyu Başlat
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Erdemli CRM Bot ${PORT} portunda başarıyla çalışıyor.`));
