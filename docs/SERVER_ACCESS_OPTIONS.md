# Serverga ulanishning ishonchli variantlari (192.248.191.30)

Holat: bu Claude sandbox'idan serverning 22-portiga **ulanib bo'lmaydi** (tarmoq cheklovi). Bu server muammosi emas. Quyidagi variantlarning hech biri Claude'ning serverga to'g'ridan-to'g'ri ulanishini talab qilmaydi.

| # | Variant | Kim bajaradi | Afzalligi | Kamchiligi |
|---|---|---|---|---|
| 1 | **Vultr Web Console** (server → View Console) | Siz, brauzerdan | SSH ishlamasa ham doim ishlaydi; birinchi sozlash uchun eng ishonchli | Nusxa-ko'chirish noqulay |
| 2 | **O'z kompyuteringizdan SSH (ed25519 kalit)** | Siz | Standart, xavfsiz | Kalitni bir marta qo'shish kerak (1-variant orqali) |
| 3 | **Pull-based: `scripts/server/deploy-from-git.sh`** | Serverning o'zi (siz 1 buyruq yozasiz) | Serverga kirish kaliti hech kimga berilmaydi; GitHub'dan kodni o'zi oladi | Image'lar serverda quriladi: 1 vCPU'da birinchi marta ~10–20 daq (2 GB swap bilan) — o'lchanmagan taxmin |
| 4 | **GitHub Actions `deploy-demo` (qo'lda)** | GitHub runner, Siz "Run workflow" bosasiz | Image'lar GitHub'da quriladi (server yuklanmaydi); har deploy oldidan DB backup; log GitHub'da | Deploy kaliti va `.env` GitHub Secrets'ga qo'yiladi |

**Tavsiya:** 1 → 2 (kalit qo'shish va `bootstrap-demo.sh`) → keyin 3 yoki 4. Repozitoriy private bo'lsa, 3-variant uchun serverga faqat o'qish huquqli GitHub deploy key (Settings → Deploy keys, read-only) qo'shiladi.

## 1-variant: birinchi kirish (Vultr Web Console)
```bash
# root sifatida, Vultr konsolida:
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAA... sizning-ochiq-kalitingiz" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

## 2-variant: o'z kompyuteringizdan
```bash
ssh-keygen -t ed25519 -C "uzshop-demo"      # bir marta, kompyuteringizda
ssh root@192.248.191.30                     # birinchi ulanishda host fingerprint'ini Vultr konsolidagi bilan solishtiring
curl -fsSL https://raw.githubusercontent.com/tdilshodbek1994-jpg/Online-magazin/claude/online-marketplace-platform-sdtv52/scripts/server/bootstrap-demo.sh -o bootstrap-demo.sh
less bootstrap-demo.sh && bash bootstrap-demo.sh   # (repo private bo'lsa — faylni qo'lda nusxalang)
```

## 3-variant: pull-based deploy
```bash
su - om
git clone <repo-url> online-magazin && cd online-magazin && cp .env.example .env && nano .env   # OM_DOMAIN, parollar
scripts/server/deploy-from-git.sh --seed
```

## SSH ishlamasa tekshirish ro'yxati (o'z kompyuteringizdan)
1. `ping 192.248.191.30` va `nc -vz 192.248.191.30 22` — port ochiqmi.
2. Vultr → Firewall group 22/tcp sizning IP'ingizga ochiqmi.
3. Serverda (Web Console): `systemctl status ssh`, `ufw status`, `ss -ltnp | grep :22`.
4. `ssh -v root@192.248.191.30` chiqishidagi `Permission denied (publickey)` → kalit `authorized_keys`da yo'q.
