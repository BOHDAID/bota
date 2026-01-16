# استخدام نسخة خفيفة من Node.js
FROM node:20-slim

# تحديث بسيط للنظام (احتياطي) وتثبيت git
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# إنشاء مجلد العمل
WORKDIR /usr/src/app

# نسخ ملفات التعريف وتثبيت المكتبات
COPY package*.json ./
RUN npm install

# نسخ باقي ملفات البوت
COPY . .

# أمر التشغيل
CMD ["node", "index.js"]
