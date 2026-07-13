module.exports = {
  TOKEN: process.env.TELEGRAM_TOKEN || "8554649250:AAGIEzd5-f0zAl32pBVxUo-ZOuVtWD9ZkEg",
  OWNER_ID: process.env.OWNER_ID || 1677459127,

  // Grup utama (bisa diisi ID grup yang tidak punya role khusus, misal untuk broadcast atau notifikasi)
  ID_GROUP: [
    -1003962746153
  ],
  ID_GROUP_UTAMA: [
    -1003962746153
  ],

  // PEMETAAN ID GRUP → ROLE
  // Ganti ID grup di bawah ini dengan ID grup Telegram Anda yang sebenarnya
  ROLE_GROUP_MAP: {
    '-1002525390480': 'reseller',
    '-1003313353881': 'admin',
    '-1003301432354': 'vip',
    '-1003469607027': 'member',
    '-10034': 'owner',
    '-1003587557671': 'high admin',
    '-1003587557671': 'moderator',
    '-1003467259599': 'founder'
  },

  // Semua grup yang diizinkan (otomatis tergabung dari ID_GROUP dan ROLE_GROUP_MAP)
  get ALLOWED_GROUPS() {
    const groupIds = [
      ...(this.ID_GROUP || []),
      ...(this.ID_GROUP_UTAMA || []),
      ...Object.keys(this.ROLE_GROUP_MAP || {}).map(Number)
    ];
    // Hilangkan duplikat
    return [...new Set(groupIds)];
  }
};
