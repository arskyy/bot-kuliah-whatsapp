import crypto from 'crypto';
import { webcrypto } from 'crypto';
const { subtle, getRandomValues } = webcrypto;

// Import Baileys & Utils pendukung terbaru
import {
  useMultiFileAuthState,
  makeWASocket,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion, 
  delay 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs-extra';
import path from 'path';
import readline from 'readline'; // Tambahan untuk membaca input terminal

import config from './config.js';
import * as akademikHandler from './commands/akademik.js';
import reminderHandler from './commands/reminder.js';
import systemHandler from './commands/system.js';
import tugasHandler from './commands/tugas.js';
import modulHandler, { getFolderName } from './commands/modul.js';
import downloadHandler from './commands/download.js';
import liburkanHandler from './commands/liburkan.js';
import liburlistHandler from './commands/liburlist.js';
import { processGeminiChat } from './commands/gemini.js';

import cronJobs from './utils/cron.js';
import logger from './utils/logger.js';

// Fungsi bantuan untuk menerima input nomor telepon di terminal
function question(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
}

const ensureDirectories = async () => {
  await fs.ensureDir('./auth_info_baileys');
  await fs.ensureDir('./data');
  if (!await fs.pathExists('./data/tugas.json')) {
    await fs.writeJson('./data/tugas.json', {});
  }
};

async function connectToWhatsApp() {
  await ensureDirectories();
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  // Ambil versi WA Web terbaru secara dinamis agar stabil
  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {
    version = [2, 3000, 1015901307]; // Fallback version jika gagal fetch
  }

  // Socket Teroptimasi disesuaikan dengan versi terbaru
  const sock = makeWASocket({
    version, 
    printQRInTerminal: false, // ❌ Dimatikan karena beralih ke Pairing Code
    auth: state,
    logger: pino({ level: 'silent' }), 
    browser: ['Linux', 'Firefox', '120.0'], // Menggunakan standar browser modern agar pairing code sukses
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 120000,
    keepAliveIntervalMs: 30000,
  });

  // ─── LOGIKA PAIRING CODE ───
  if (!sock.authState.creds.registered) {
    console.log('\n=== WHATSAPP BOT PAIRING ===');
    console.log('Format nomor gunakan kode negara tanpa tanda +, contoh: 628123456789\n');

    const input = await question('📱 Masukkan Nomor WhatsApp Bot Anda: ');
    const phoneNumber = input.replace(/\D/g, ''); // Membersihkan karakter non-angka

    if (!phoneNumber.match(/^\d{10,15}$/)) {
      console.log('❌ Nomor tidak valid! Harap jalankan ulang bot dan isi dengan benar.');
      process.exit(1);
    }

    // Melakukan percobaan pemanggilan Pairing Code (Maksimal 3 kali)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await delay(3000); // Jeda sebelum request agar server tidak menganggap spam
        const pairingCode = await sock.requestPairingCode(phoneNumber);
        
        console.log(`\n========================================`);
        console.log(`[➔] KODE PAIRING ANDA: \x1b[1;\x1b[35m${pairingCode}\x1b[0m`);
        console.log(`========================================`);
        console.log('Silakan masukkan kode di atas pada menu WhatsApp HP Anda:');
        console.log('Perangkat Tautan (Linked Devices) -> Tautkan dengan nomor telepon\n');
        break; 
      } catch (err) {
        if (attempt >= 3) {
          console.log('❌ Gagal generate pairing code setelah 3 percobaan. Pastikan nomor aktif.');
          process.exit(1);
        }
        await delay(5000);
      }
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      logger.info('✅ Bot berhasil terhubung!');
      cronJobs.initScheduler(sock);
    } else if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : null;

      // Logika reconnect mutakhir dari versi terbaru  
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;  

      if (shouldReconnect) {  
        logger.warn(`🔁 Koneksi terputus (${statusCode}), mencoba kembali dalam 3 detik...`);  
        await delay(3000);  
        connectToWhatsApp();  
      } else {  
        logger.error('❌ Sesi keluar (Logged Out). Hapus folder auth_info_baileys lalu restart bot.');  
      }  
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!messages) return;
    const msg = messages[0]; // Memperbaiki bug tipografi 'msg = messages' agar mengambil indeks pertama array

    const chatId = msg.key.remoteJid;  
    const sender = msg.key.participant || msg.key.remoteJid;  
    const senderNo = sender.split('@')[0]; // Memperbaiki logika split nomor untuk mencocokkan string di bawah
    const isFromGroup = chatId.endsWith('@g.us');  
    const isAllowedGroup = config.groupIds.includes(chatId);  
    const isOwner = config.owner.includes(`${senderNo}@s.whatsapp.net`);  
    const isAdmin = isOwner || config.systemCommands.allowedUsers.includes(`${senderNo}@s.whatsapp.net`);  

    let body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';  
    let cleanBody = body.trim();  

    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;  

    logger.debug(` chatId: ${chatId}, sender: ${sender}, isFromGroup: ${isFromGroup}`);  
    logger.debug(` cleanBody: ${cleanBody}`);  

    // ✅ Upload modul (Tetap menggunakan prefix khusus "!" agar tidak bertabrakan)
    const docMsg = msg.message?.documentMessage ||  
                   msg.message?.documentWithCaptionMessage?.message?.documentMessage;  
    const rawCaption = docMsg?.caption || '';  
    if (rawCaption.trim().toLowerCase().startsWith('!upload')) {  
      try {  
        if (!isAdmin) {  
          await sock.sendMessage(chatId, { text: '⚠️ Hanya admin yang boleh upload modul.' });  
          return;  
        }  

        const kode = rawCaption.split(' ')?.[1]?.toLowerCase();  
        const folder = getFolderName(kode);  
        if (!folder) {  
          await sock.sendMessage(chatId, { text: `❌ Kode matkul tidak dikenali: ${kode}` });  
          return;  
        }  

        const fileName = docMsg.fileName || `file_${Date.now()}.pdf`;  
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino() });  
        const targetPath = path.join('./data/modul', folder, fileName);  

        await fs.ensureDir(path.dirname(targetPath));  
        await fs.writeFile(targetPath, buffer);  

        await sock.sendMessage(chatId, { text: `✅ File *${fileName}* disimpan ke *${folder}*.` });  
        logger.info(` File ${fileName} disimpan ke ${targetPath}`);  
        return;  
      } catch (error) {  
        logger.error(` Error: ${error.message}`);  
        await sock.sendMessage(chatId, { text: '❌ Gagal upload modul.' });  
        return;  
      }  
    }  

    // 🔍 SISTEM MULTI-PREFIX OTOMATIS
    const prefixRegex = /^[.!z#?$+=/\\©^,]/; 
    const hasPrefix = prefixRegex.test(cleanBody);
    
    if (!hasPrefix) return; 

    const prefix = cleanBody.match(prefixRegex)[0];

    try {  
      const [cmd, ...args] = cleanBody.slice(prefix.length).trim().split(' ');  

      if (cmd === 'ask') {  
        const prompt = args.join(' ').trim();  
        if (!prompt) {  
          await sock.sendMessage(chatId, { text: `❓ Pertanyaanmu kosong. Contoh: \`${prefix}ask kapan uas?\`` });  
          return;  
        }  
        await processGeminiChat(sock, chatId, prompt);  
        return;  
      }  

      if (cmd === 'help' || cmd === 'menu') await systemHandler.sendHelpMenu(sock, chatId);  
      if (cmd === 'idgrup') await sock.sendMessage(chatId, { text: `ID grup ini: ${chatId}` });  

      if (isAdmin) {  
        if (cmd === 'status') await systemHandler.getSystemStatus(sock, chatId);  
        if (cmd === 'reboot') await systemHandler.rebootSystem(sock, chatId);  
        if (cmd === 'update') await systemHandler.updateSystem(sock, chatId);  
        if (cmd === 'uptime') await systemHandler.getUptime(sock, chatId);  
        if (cmd === 'memory') await systemHandler.getMemoryUsage(sock, chatId);  
        if (cmd === 'cpu') await systemHandler.getCpuUsage(sock, chatId);  
        if (cmd === 'disk') await systemHandler.getDiskUsage(sock, chatId);  
      }  

      if (cmd === 'jadwal') {  
        const keyword = args[0]?.toLowerCase();  
        if (keyword === 'besok') {  
          const data = await akademikHandler.getJadwalBesok();  
          await sock.sendMessage(chatId, { text: akademikHandler.formatJadwal(data) });  
        } else {  
          await akademikHandler.sendJadwal(sock, chatId);  
        }  
      }  

      if (cmd === 'kalender') await akademikHandler.sendKalender(sock, chatId);  

      if (cmd === 'tugas') {  
        if (args[0] === 'tambah') await tugasHandler.addTugas(sock, chatId, sender, args.slice(1).join(' '));  
        if (args[0] === 'hapus') await tugasHandler.removeTugas(sock, chatId, sender, args[1]);  
        if (args[0] === 'list') await tugasHandler.sendTugasList(sock, chatId);  
      }  

      if (cmd === 'modul') {  
        const kode = args[0];  
        const nomor = args[1];  
        if (!kode) {  
          await modulHandler.listAllMatkul(sock, chatId);  
        } else if (kode.toLowerCase() === 'hapus') {  
          const kodeMatkul = args[1];  
          const nomorModul = args[2];  
          if (!isAdmin) {  
            await sock.sendMessage(chatId, { text: '⚠️ Hanya admin yang bisa menghapus modul.' });  
            return;  
          }  
          if (!kodeMatkul || !nomorModul) {  
            await sock.sendMessage(chatId, { text: `⚠️ Format salah. Gunakan: ${prefix}modul hapus <kode> <no>` });  
            return;  
          }  
          await modulHandler.hapusModul(sock, chatId, kodeMatkul.toLowerCase(), nomorModul);  
        } else if (!nomor) {  
          await modulHandler.listModul(sock, chatId, kode.toLowerCase());  
        } else {  
          await modulHandler.sendModul(sock, chatId, kode.toLowerCase(), nomor);  
        }  
      }  

      if (cmd === 'reminder') {  
        if (args[0] === 'tugas') await reminderHandler.sendTugasReminderManual(sock, chatId);  
        else if (args[0] === 'jadwal') await reminderHandler.sendJadwalReminder(sock, chatId);  
        else {  
          await sock.sendMessage(chatId, {  
            text: `🔔 Gunakan:\n• \`${prefix}reminder tugas\`\n• \`${prefix}reminder jadwal\``  
          });  
        }  
      }  

      if (cmd === 'liburkan') {  
        if (!isAdmin) return sock.sendMessage(chatId, { text: '⚠️ Hanya admin yang bisa meliburkan matkul.' });  
        await liburkanHandler.execute(msg, args, sock);  
        return;  
      }  

      if (cmd === 'liburlist') {  
        await liburlistHandler.execute(msg, args, sock);  
        return;  
      }  

      if (['yt', 'tt', 'ig'].includes(cmd)) {  
        const url = args[0];  
        if (!url) return sock.sendMessage(chatId, { text: '⚠️ Kirim link video setelah perintah.' });  
        await downloadHandler.handleDownload(sock, chatId, cmd, url);  
      }  
    } catch (err) {  
      logger.error(`❌ Error saat proses command: ${err.message}`);  
    }  
  });
}

connectToWhatsApp();
