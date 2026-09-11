require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PORT = Number(process.env.PORT || 3000);

const missingVars = [
  !TOKEN && "DISCORD_TOKEN",
  !CLIENT_ID && "CLIENT_ID",
  !GUILD_ID && "GUILD_ID"
].filter(Boolean);

const DEFAULT_COLOR = "#5865F2";
const PUZZLE_TTL = 10_000;
const MAX_ATTEMPTS = 3;
const COOLDOWN_MS = 30_000;
const MAX_HISTORY = 500;
const SETUP_TTL = 10 * 60_000;

const DATA_FILE = path.join(__dirname, "verification-data.json");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

const puzzleSessions = new Map();
const cooldowns = new Map();
const setupSessions = new Map();
let db = {
  guilds: {},
  history: []
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      db = {
        guilds: parsed.guilds || {},
        history: Array.isArray(parsed.history) ? parsed.history.slice(-MAX_HISTORY) : []
      };
    }
  } catch (err) {
    console.error("Storage load error:", err.message);
  }
}

function saveData() {
  try {
    const temp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(temp, DATA_FILE);
  } catch (err) {
    console.error("Storage save error:", err.message);
  }
}

function getGuildConfig(guildId) {
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = {
      embed: {
        title: "🔐 ยืนยันตัวตนสมาชิก",
        description: "ยินดีต้อนรับ! กรุณากดปุ่มด้านล่างเพื่อยืนยันตัวตน",
        image: "",
        footer: "Verification System",
        color: DEFAULT_COLOR
      },
      roleId: null,
      channelId: null,
      panelMessageId: null,
      logChannelId: null
    };
  }
  return db.guilds[guildId];
}

const COLORS = {
  success: "#57F287",
  error: "#ED4245",
  warning: "#FEE75C",
  info: "#5865F2",
  verification: "#9B59B6"
};

function baseEmbed(color = COLORS.info) {
  return new EmbedBuilder()
    .setColor(color)
    .setTimestamp();
}

function successEmbed(title, description = "") {
  return baseEmbed(COLORS.success).setTitle(`✅ ${title}`).setDescription(description);
}

function errorEmbed(title, description = "") {
  return baseEmbed(COLORS.error).setTitle(`❌ ${title}`).setDescription(description);
}

function warningEmbed(title, description = "") {
  return baseEmbed(COLORS.warning).setTitle(`⚠️ ${title}`).setDescription(description);
}

function infoEmbed(title, description = "") {
  return baseEmbed(COLORS.info).setTitle(`ℹ️ ${title}`).setDescription(description);
}

function verificationEmbed(title, description = "") {
  return baseEmbed(COLORS.verification).setTitle(`🪪 ${title}`).setDescription(description);
}

function safeColor(value) {
  return /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : DEFAULT_COLOR;
}

function buildCustomPanelEmbed(config) {
  const e = new EmbedBuilder()
    .setColor(safeColor(config.embed.color))
    .setTitle(config.embed.title || "🔐 ยืนยันตัวตนสมาชิก")
    .setDescription(config.embed.description || "กดปุ่มด้านล่างเพื่อเริ่มยืนยันตัวตน");

  if (config.embed.image) e.setImage(config.embed.image);
  if (config.embed.footer) e.setFooter({ text: config.embed.footer });
  e.setTimestamp();
  return e;
}

function buttonRow(customId, label, style = ButtonStyle.Primary, emoji) {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return new ActionRowBuilder().addComponents(b);
}

function safeMentionRole(guild, roleId) {
  const role = guild.roles.cache.get(roleId);
  return role ? `<@&${roleId}>` : "ไม่พบยศ";
}

function safeMentionChannel(guild, channelId) {
  const ch = guild.channels.cache.get(channelId);
  return ch ? `<#${channelId}>` : "ไม่พบห้อง";
}

function validUrl(value) {
  if (!value) return true;
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
}

function cleanText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function canManageRole(guild, role) {
  const me = guild.members.me;
  if (!me) return false;
  return (
    guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles) &&
    role.position < me.roles.highest.position &&
    !role.managed
  );
}

function canUseChannel(guild, channel) {
  const me = guild.members.me;
  if (!me || !channel) return false;
  const perms = channel.permissionsFor(me);
  return perms?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
  ]);
}

const PUZZLE_EMOJIS = [
  ["😀", "😃"], ["😎", "🤓"], ["🐶", "🐱"], ["🍎", "🍏"],
  ["⭐", "🌟"], ["🔥", "✨"], ["🌙", "🌚"], ["☀️", "🌞"],
  ["❤️", "🧡"], ["🟦", "🟩"], ["🔵", "🟣"], ["⚪", "⚫"],
  ["🍔", "🍟"], ["🚗", "🚕"], ["🎈", "🎀"], ["🐼", "🐨"]
];

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function createPuzzle() {
  const levels = [
    { name: "Easy", size: 3 },
    { name: "Normal", size: 4 },
    { name: "Hard", size: 5 }
  ];

  const level = levels[randomInt(levels.length)];
  const pair = PUZZLE_EMOJIS[randomInt(PUZZLE_EMOJIS.length)];
  const answerIndex = randomInt(level.size * level.size);
  const cells = Array(level.size * level.size).fill(pair[0]);
  cells[answerIndex] = pair[1];

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    id,
    level: level.name,
    size: level.size,
    cells,
    answerIndex,
    startedAt: Date.now(),
    expiresAt: Date.now() + PUZZLE_TTL
  };
}

function puzzleButtons(session) {
  const rows = [];
  for (let r = 0; r < session.size; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < session.size; c++) {
      const index = r * session.size + c;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`puzzle:${session.id}:${index}`)
          .setLabel(String(index + 1))
          .setStyle(ButtonStyle.Secondary)
      );
    }
    rows.push(row);
  }
  return rows;
}

function puzzleEmbed(session) {
  const remaining = Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000));
  return verificationEmbed(
    "👀 ค้นหาสัญลักษณ์ที่แตกต่าง",
    "เลือกช่องที่มีสัญลักษณ์แตกต่างจากช่องอื่น"
  )
    .addFields(
      { name: "🧩 Level", value: session.level, inline: true },
      { name: "⏱️ time", value: `${remaining} วินาที`, inline: true },
      { name: "🎯 attempts", value: `${session.attempts}/${MAX_ATTEMPTS}`, inline: true },
      { name: "🔎 ตาราง", value: session.cells.map((x, i) => `${x} ${i + 1}`).join("  ") }
    )
    .setFooter({ text: `Puzzle ID: ${session.id}` });
}

function cleanupPuzzle(userId) {
  const session = puzzleSessions.get(userId);
  if (session?.timer) clearTimeout(session.timer);
  puzzleSessions.delete(userId);
}

function cleanupCooldowns() {
  const now = Date.now();
  for (const [key, expires] of cooldowns) {
    if (expires <= now) cooldowns.delete(key);
  }
}

function setupSessionKey(userId, guildId) {
  return `${guildId}:${userId}`;
}

function cleanupSetup(key) {
  setupSessions.delete(key);
}

function setupModal(session) {
  const modal = new ModalBuilder()
    .setCustomId("setup:embed")
    .setTitle("🎨 ปรับแต่ง Embed");

  const title = new TextInputBuilder()
    .setCustomId("title")
    .setLabel("ชื่อหัวข้อ")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(256)
    .setValue(session.embed?.title || "");

  const description = new TextInputBuilder()
    .setCustomId("description")
    .setLabel("รายละเอียด")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setValue(session.embed?.description || "");

  const image = new TextInputBuilder()
    .setCustomId("image")
    .setLabel("ลิงก์รูปภาพ (เว้นว่างได้)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(session.embed?.image || "");

  const footer = new TextInputBuilder()
    .setCustomId("footer")
    .setLabel("ข้อความท้าย Embed")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(2048)
    .setValue(session.embed?.footer || "");

  const color = new TextInputBuilder()
    .setCustomId("color")
    .setLabel("สี Hex เช่น #5865F2")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(7)
    .setValue(session.embed?.color || DEFAULT_COLOR);

  modal.addComponents(
    new ActionRowBuilder().addComponents(title),
    new ActionRowBuilder().addComponents(description),
    new ActionRowBuilder().addComponents(image),
    new ActionRowBuilder().addComponents(footer),
    new ActionRowBuilder().addComponents(color)
  );

  return modal;
}

function setupPreview(session) {
  const e = new EmbedBuilder()
    .setColor(safeColor(session.embed.color))
    .setTitle(session.embed.title)
    .setDescription(session.embed.description)
    .addFields(
      { name: "🪪 ยศ", value: session.roleId ? `<@&${session.roleId}>` : "ยังไม่ได้เลือก", inline: true },
      { name: "📍 ห้อง", value: session.channelId ? `<#${session.channelId}>` : "ยังไม่ได้เลือก", inline: true }
    )
    .setFooter({ text: session.embed.footer || "Verification System" })
    .setTimestamp();

  if (session.embed.image) e.setImage(session.embed.image);

  return e;
}

function addHistory(record) {
  db.history.push(record);
  if (db.history.length > MAX_HISTORY) {
    db.history = db.history.slice(-MAX_HISTORY);
  }
  saveData();
}

async function sendVerificationLog(guild, record) {
  const config = getGuildConfig(guild.id);
  if (!config.logChannelId) return;

  const channel = guild.channels.cache.get(config.logChannelId);
  if (!channel || !canUseChannel(guild, channel)) return;

  const success = record.result === "success";
  const embed = baseEmbed(success ? COLORS.success : COLORS.error)
    .setTitle(success ? "ยืนยันตัวตนสำเร็จ" : "ยืนยันตัวตนไม่สำเร็จ")
    .addFields(
      { name: "👤 สมาชิก", value: `<@${record.userId}>`, inline: true },
      { name: "🆔 User ID", value: record.userId, inline: true },
      { name: "🧩 Puzzle", value: record.puzzleType, inline: true },
      { name: "🎚️ ระดับ", value: record.difficulty, inline: true },
      { name: "🎯 Attempts", value: `${record.attempts}`, inline: true },
      { name: "⏱️ เวลา", value: record.completionTime ? `${record.completionTime.toFixed(2)} วินาที` : "-", inline: true },
      { name: "🪪 Role", value: safeMentionRole(guild, record.roleId), inline: true },
      { name: "📌 ผลลัพธ์", value: success ? "สำเร็จ" : "ล้มเหลว", inline: true }
    )
    .setFooter({ text: `Verification System • ${guild.name}` });

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Log send error:", err.message);
  }
}

function dashboardEmbed(guild) {
  const config = getGuildConfig(guild.id);
  const records = db.history.filter(x => x.guildId === guild.id);
  const success = records.filter(x => x.result === "success");
  const failed = records.filter(x => x.result === "failed");
  const avg = success.length
    ? success.reduce((sum, x) => sum + (x.completionTime || 0), 0) / success.length
    : 0;
  const rate = records.length ? (success.length / records.length) * 100 : 0;

  return infoEmbed(
    "Verification Dashboard",
    "ภาพรวมระบบยืนยันตัวตนของ Server"
  ).addFields(
    { name: "👥 สมาชิกที่ผ่านทั้งหมด", value: String(success.length), inline: true },
    { name: "🧩 Attempts ทั้งหมด", value: String(records.length), inline: true },
    { name: "✅ สำเร็จ", value: String(success.length), inline: true },
    { name: "❌ ล้มเหลว", value: String(failed.length), inline: true },
    { name: "📈 Success Rate", value: `${rate.toFixed(1)}%`, inline: true },
    { name: "⏱️ เวลาเฉลี่ย", value: avg ? `${avg.toFixed(2)} วินาที` : "-", inline: true },
    { name: "🪪 Role", value: config.roleId ? safeMentionRole(guild, config.roleId) : "ยังไม่ได้ตั้งค่า", inline: true },
    { name: "📍 Log", value: config.logChannelId ? safeMentionChannel(guild, config.logChannelId) : "ปิดอยู่", inline: true }
  );
}

function dashboardButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("log:members:0").setLabel("รายชื่อสมาชิก").setEmoji("👥").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("log:stats").setLabel("สถิติ").setEmoji("📊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("log:recent:0").setLabel("Log ล่าสุด").setEmoji("📋").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("log:refresh").setLabel("รีเฟรช").setEmoji("🔄").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("log:close").setLabel("ปิด").setEmoji("❌").setStyle(ButtonStyle.Danger)
  );
}

function membersEmbed(guild, page) {
  const records = db.history
    .filter(x => x.guildId === guild.id && x.result === "success")
    .sort((a, b) => b.timestamp - a.timestamp);

  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(records.length / perPage));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageItems = records.slice(safePage * perPage, safePage * perPage + perPage);

  const description = pageItems.length
    ? pageItems.map((x, i) =>
        `**${safePage * perPage + i + 1}.** <@${x.userId}>\n` +
        `└ 🕐 <t:${Math.floor(x.timestamp / 1000)}:f> • ⏱️ ${(x.completionTime || 0).toFixed(2)} วินาที`
      ).join("\n\n")
    : "ยังไม่มีสมาชิกที่ผ่านการยืนยันตัวตน";

  return infoEmbed("👥 สมาชิกที่ยืนยันตัวตนแล้ว", description)
    .setFooter({ text: `หน้า ${safePage + 1}/${totalPages}` });
}

function membersButtons(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`log:members:${Math.max(0, page - 1)}`).setLabel("ก่อนหน้า").setEmoji("⬅️").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`log:members:${Math.min(totalPages - 1, page + 1)}`).setLabel("ถัดไป").setEmoji("➡️").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId("log:dashboard").setLabel("กลับ").setEmoji("🔙").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("log:close").setLabel("ปิด").setEmoji("❌").setStyle(ButtonStyle.Danger)
  );
}

function recentEmbed(guild, page) {
  const records = db.history
    .filter(x => x.guildId === guild.id)
    .sort((a, b) => b.timestamp - a.timestamp);

  const perPage = 8;
  const totalPages = Math.max(1, Math.ceil(records.length / perPage));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const items = records.slice(safePage * perPage, safePage * perPage + perPage);

  const description = items.length
    ? items.map(x =>
        `**<@${x.userId}>** — ${x.result === "success" ? "✅ สำเร็จ" : "❌ ล้มเหลว"}\n` +
        `└ 🧩 ${x.difficulty} • 🕐 <t:${Math.floor(x.timestamp / 1000)}:f>`
      ).join("\n\n")
    : "ยังไม่มี Log";

  return infoEmbed("📋 Log ล่าสุด", description)
    .setFooter({ text: `หน้า ${safePage + 1}/${totalPages}` });
}

function paginationButtons(prefix, page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:${Math.max(0, page - 1)}`).setLabel("ก่อนหน้า").setEmoji("⬅️").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`${prefix}:${Math.min(totalPages - 1, page + 1)}`).setLabel("ถัดไป").setEmoji("➡️").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId("log:dashboard").setLabel("กลับ").setEmoji("🔙").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("log:close").setLabel("ปิด").setEmoji("❌").setStyle(ButtonStyle.Danger)
  );
}


const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("ตั้งค่าระบบ"),
  new SlashCommandBuilder()
    .setName("setup-edit")
    .setDescription("แก้ไข"),
  new SlashCommandBuilder()
    .setName("set")
    .setDescription("ตั้งค่าlog")
    .addSubcommand(sub =>
      sub.setName("log").setDescription("ตั้งค่าห้อง Log")
    ),
  new SlashCommandBuilder()
    .setName("log")
    .setDescription("ดู Dashboard")
].map(x => x.toJSON());


async function requireAdmin(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      ephemeral: true,
      embeds: [errorEmbed("ไม่มีสิทธิ์", "คำสั่งนี้ใช้ได้เฉพาะผู้ดูแล Server เท่านั้น")]
    });
    return false;
  }
  return true;
}

async function startPuzzle(interaction) {
  const guild = interaction.guild;
  const userId = interaction.user.id;
  const config = getGuildConfig(guild.id);

  if (!config.roleId) {
    await interaction.editReply({
      embeds: [errorEmbed("ระบบยังตั้งค่าไม่ครบ", "กรุณาให้หัวดิสตั้งค่า Role ก่อน")]
    });
    return;
  }

  const role = guild.roles.cache.get(config.roleId);
  if (!role) {
    await interaction.editReply({
      embeds: [errorEmbed("ไม่พบยศ", "ยศสำหรับสมาชิกถูกลบหรือไม่มีอยู่แล้ว")]
    });
    return;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    await interaction.editReply({
      embeds: [errorEmbed("ไม่พบสมาชิก", "ไม่สามารถตรวจสอบสมาชิกใน Server ได้")]
    });
    return;
  }

  if (member.roles.cache.has(role.id)) {
    await interaction.editReply({
      embeds: [infoEmbed("คุณได้รับยศแล้ว", `คุณมียศ ${role} อยู่แล้ว`)]
    });
    return;
  }

  cleanupCooldowns();
  const cooldownKey = `${guild.id}:${userId}`;
  const cooldown = cooldowns.get(cooldownKey);

  if (cooldown && cooldown > Date.now()) {
    const seconds = Math.ceil((cooldown - Date.now()) / 1000);
    await interaction.editReply({
      embeds: [warningEmbed("ยังอยู่ในช่วง Cooldown", `กรุณารออีก **${seconds} วินาที** แล้วลองใหม่`)]
    });
    return;
  }

  cleanupPuzzle(userId);

  await interaction.editReply({
    embeds: [verificationEmbed("กำลังสร้าง Puzzle...", "กำลังเตรียมระบบยืนยันตัวตน")]
  });

  const session = createPuzzle();
  session.userId = userId;
  session.guildId = guild.id;
  session.attempts = 0;
  session.roleId = role.id;
  session.timer = setTimeout(async () => {
    const current = puzzleSessions.get(userId);
    if (!current || current.id !== session.id) return;

    puzzleSessions.delete(userId);

    const record = {
      userId,
      guildId: guild.id,
      timestamp: Date.now(),
      puzzleType: "Find the Odd One",
      difficulty: session.level,
      attempts: session.attempts,
      completionTime: null,
      result: "failed",
      roleId: role.id
    };

    addHistory(record);
    await sendVerificationLog(guild, record);

    try {
      await interaction.editReply({
        embeds: [warningEmbed("หมดเวลา", "คุณใช้เวลานานเกินไปในการแก้ Puzzle")]
          .addFields(
            { name: "Puzzle", value: "Find the Odd One", inline: true },
            { name: "ผลลัพธ์", value: "หมดเวลา", inline: true }
          ),
        components: [buttonRow(`verify:retry:${Date.now()}`, "ลองใหม่", ButtonStyle.Primary, "🔄")]
      });
    } catch (err) {
      console.error("Timeout edit error:", err.message);
    }
  }, PUZZLE_TTL);

  puzzleSessions.set(userId, session);

  await interaction.editReply({
    embeds: [puzzleEmbed(session)],
    components: puzzleButtons(session)
  });
}

async function handlePuzzle(interaction, sessionId, index) {
  const userId = interaction.user.id;
  const session = puzzleSessions.get(userId);

  if (!session || session.id !== sessionId || session.userId !== userId) {
    await interaction.reply({
      ephemeral: true,
      embeds: [errorEmbed("Puzzle ใช้งานไม่ได้", "Puzzle นี้หมดอายุหรือไม่ใช่ของคุณแล้ว")]
    });
    return;
  }

  if (Date.now() >= session.expiresAt) {
    cleanupPuzzle(userId);
    await interaction.reply({
      ephemeral: true,
      embeds: [warningEmbed("Puzzle หมดอายุ", "กรุณากดเริ่มใหม่อีกครั้ง")]
    });
    return;
  }

  const selected = Number(index);
  if (!Number.isInteger(selected) || selected < 0 || selected >= session.cells.length) {
    await interaction.reply({
      ephemeral: true,
      embeds: [errorEmbed("ข้อมูลไม่ถูกต้อง", "ไม่สามารถใช้ปุ่มนี้ได้")]
    });
    return;
  }

  if (session.processing) {
    await interaction.reply({
      ephemeral: true,
      embeds: [warningEmbed("กำลังตรวจสอบ", "กรุณารอสักครู่")]
    });
    return;
  }

  session.processing = true;

  if (selected !== session.answerIndex) {
    session.attempts += 1;
    session.processing = false;

    if (session.attempts >= MAX_ATTEMPTS) {
      const guild = interaction.guild;
      const record = {
        userId,
        guildId: guild.id,
        timestamp: Date.now(),
        puzzleType: "Find the Odd One",
        difficulty: session.level,
        attempts: session.attempts,
        completionTime: (Date.now() - session.startedAt) / 1000,
        result: "failed",
        roleId: session.roleId
      };

      cleanupPuzzle(userId);
      cooldowns.set(`${guild.id}:${userId}`, Date.now() + COOLDOWN_MS);
      addHistory(record);
      await sendVerificationLog(guild, record);

      await interaction.update({
        embeds: [warningEmbed("🔒 ถูกจำกัดชั่วคราว", "คุณตอบผิดครบจำนวนครั้งที่กำหนด")
          .addFields(
            { name: "❌ Attempts", value: `${MAX_ATTEMPTS}/${MAX_ATTEMPTS}`, inline: true },
            { name: "⏳ Cooldown", value: "30 วินาที", inline: true }
          )],
        components: []
      });
      return;
    }

    await interaction.update({
      embeds: [errorEmbed("คำตอบไม่ถูกต้อง", "คุณเลือกตำแหน่งผิด")
        .addFields(
          { name: "🎯 ครั้งที่", value: `${session.attempts}/${MAX_ATTEMPTS}`, inline: true },
          { name: "🧩 Puzzle", value: "Find the Odd One", inline: true }
        )],
      components: (() => {
        const rows = puzzleButtons(session);
        if (rows.length < 5) {
          rows.push(buttonRow(`verify:retry:${session.id}`, "ลองใหม่", ButtonStyle.Primary, "🔄"));
        }
        return rows;
      })()
    });
    return;
  }

  const guild = interaction.guild;
  const member = await guild.members.fetch(userId).catch(() => null);
  const role = guild.roles.cache.get(session.roleId);
  const completionTime = (Date.now() - session.startedAt) / 1000;

  if (!member || !role || !canManageRole(guild, role)) {
    session.processing = false;
    await interaction.update({
      embeds: [errorEmbed("ไม่สามารถมอบยศได้", "กรุณาแจ้งผู้ดูแลให้ตรวจสอบสิทธิ์ของ Bot และลำดับยศ")],
      components: []
    });
    cleanupPuzzle(userId);
    return;
  }

  if (member.roles.cache.has(role.id)) {
    cleanupPuzzle(userId);
    await interaction.update({
      embeds: [infoEmbed("คุณได้รับยศแล้ว", `คุณมียศ ${role} อยู่แล้ว`)],
      components: []
    });
    return;
  }

  try {
    await interaction.update({
      embeds: [verificationEmbed("👀 กำลังตรวจคำตอบ...", "กำลังยืนยันผลและมอบยศให้คุณ")],
      components: []
    });

    await member.roles.add(role, "ผ่านระบบยืนยันตัวตน");

    const record = {
      userId,
      guildId: guild.id,
      timestamp: Date.now(),
      puzzleType: "Find the Odd One",
      difficulty: session.level,
      attempts: session.attempts + 1,
      completionTime,
      result: "success",
      roleId: role.id
    };

    addHistory(record);
    await sendVerificationLog(guild, record);
    cleanupPuzzle(userId);

    await interaction.editReply({
      embeds: [successEmbed("ยืนยันตัวตนสำเร็จ", "ยินดีต้อนรับเข้าสู่ Server!")
        .addFields(
          { name: "🧩 Puzzle", value: "Find the Odd One", inline: true },
          { name: "⏱️ เวลา", value: `${completionTime.toFixed(2)} วินาที`, inline: true },
          { name: "🎯 ความแม่นยำ", value: "100%", inline: true },
          { name: "🪪 ยศที่ได้รับ", value: `${role}`, inline: true }
        )
        .setFooter({ text: "Verification System" })],
      components: []
    });
  } catch (err) {
    session.processing = false;
    console.error("Role assignment error:", err.message);

    await interaction.editReply({
      embeds: [errorEmbed("มอบยศไม่สำเร็จ", "Bot ไม่สามารถมอบยศให้คุณได้ กรุณาแจ้งผู้ดูแล")]
    }).catch(() => {});

    cleanupPuzzle(userId);
  }
}


client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    client.user.setPresence({
      status: "online",
      activities: [
        {
          name: "Developer : LevelingX",
          type: ActivityType.Custom,
          state: "Developer : LevelingX"
        }
      ]
    });
  } catch (err) {
    console.error("setPresence error:", err.message);
  }

  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("Guild slash commands registered.");
  } catch (err) {
    console.error("Command registration error:", err.message);
  }
});

client.on("error", err => {
  console.error("Discord client error:", err.message);
});

client.on("shardError", err => {
  console.error("Discord shard error:", err.message);
});


client.on("interactionCreate", async interaction => {
  try {
    if (!interaction.guild) {
      if (interaction.isRepliable() && !interaction.replied) {
        await interaction.reply({
          ephemeral: true,
          embeds: [errorEmbed("ใช้คำสั่งใน Server", "ระบบนี้ต้องใช้งานภายใน Discord Server")]
        });
      }
      return;
    }

    // ---------------- Slash Commands ----------------

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setup") {
        if (!(await requireAdmin(interaction))) return;

        const key = setupSessionKey(interaction.user.id, interaction.guild.id);
        const config = getGuildConfig(interaction.guild.id);

        setupSessions.set(key, {
          userId: interaction.user.id,
          guildId: interaction.guild.id,
          step: "embed",
          createdAt: Date.now(),
          embed: { ...config.embed },
          roleId: config.roleId,
          channelId: config.channelId
        });

        await interaction.showModal(setupModal(setupSessions.get(key)));
        return;
      }

      if (interaction.commandName === "setup-edit") {
        if (!(await requireAdmin(interaction))) return;

        const config = getGuildConfig(interaction.guild.id);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("setupedit:embed").setLabel("แก้ไข Embed").setEmoji("🎨").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("setupedit:role").setLabel("เปลี่ยนยศ").setEmoji("🪪").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("setupedit:channel").setLabel("เปลี่ยนห้อง").setEmoji("📍").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("setupedit:delete").setLabel("ลบระบบ").setEmoji("🗑️").setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({
          ephemeral: true,
          embeds: [infoEmbed("⚙️ แก้ไขระบบรับยศ", "เลือกสิ่งที่ต้องการแก้ไข")
            .addFields(
              { name: "🎨 Embed", value: config.embed.title || "-", inline: true },
              { name: "🪪 ยศ", value: config.roleId ? safeMentionRole(interaction.guild, config.roleId) : "ยังไม่ได้ตั้ง", inline: true },
              { name: "📍 ห้อง", value: config.channelId ? safeMentionChannel(interaction.guild, config.channelId) : "ยังไม่ได้ตั้ง", inline: true }
            )],
          components: [row]
        });
        return;
      }

      if (interaction.commandName === "set" && interaction.options.getSubcommand() === "log") {
        if (!(await requireAdmin(interaction))) return;

        const config = getGuildConfig(interaction.guild.id);

        const row = new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId("setlog:channel")
            .setPlaceholder("📍 เลือกห้อง Log")
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        );

        const components = [row];
        if (config.logChannelId) {
          components.push(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("setlog:disable").setLabel("ปิด Log").setEmoji("🔕").setStyle(ButtonStyle.Danger)
            )
          );
        }

        await interaction.reply({
          ephemeral: true,
          embeds: [infoEmbed("📋 ตั้งค่าระบบ Log", config.logChannelId
            ? `ห้อง Log ปัจจุบัน: ${safeMentionChannel(interaction.guild, config.logChannelId)}\nเลือกห้องใหม่ได้ด้านล่าง`
            : "เลือกห้องสำหรับบันทึกประวัติการยืนยันตัวตน")],
          components
        });
        return;
      }

      if (interaction.commandName === "log") {
        if (!(await requireAdmin(interaction))) return;

        await interaction.reply({
          ephemeral: true,
          embeds: [dashboardEmbed(interaction.guild)],
          components: [dashboardButtons()]
        });
        return;
      }
    }

    
    if (interaction.isModalSubmit() && interaction.customId === "setup:embed") {
      if (!(await requireAdmin(interaction))) return;

      const key = setupSessionKey(interaction.user.id, interaction.guild.id);
      const session = setupSessions.get(key);

      if (!session || Date.now() - session.createdAt > SETUP_TTL) {
        cleanupSetup(key);
        await interaction.reply({
          ephemeral: true,
          embeds: [errorEmbed("Setup หมดอายุ", "กรุณาใช้ /setup ใหม่อีกครั้ง")]
        });
        return;
      }

      const embed = {
        title: cleanText(interaction.fields.getTextInputValue("title"), 256),
        description: cleanText(interaction.fields.getTextInputValue("description"), 4000),
        image: cleanText(interaction.fields.getTextInputValue("image"), 1000),
        footer: cleanText(interaction.fields.getTextInputValue("footer"), 2048),
        color: cleanText(interaction.fields.getTextInputValue("color"), 7)
      };

      if (!/^#[0-9A-Fa-f]{6}$/.test(embed.color)) {
        await interaction.reply({
          ephemeral: true,
          embeds: [errorEmbed("สีไม่ถูกต้อง", "กรุณาใช้รูปแบบ Hex เช่น #5865F2")]
        });
        return;
      }

      if (!validUrl(embed.image)) {
        await interaction.reply({
          ephemeral: true,
          embeds: [errorEmbed("ลิงก์รูปภาพไม่ถูกต้อง", "กรุณาใส่ URL ที่ขึ้นต้นด้วย http:// หรือ https://")]
        });
        return;
      }

      session.embed = embed;
      session.step = "preview";

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("setup:confirm").setLabel("ยืนยัน").setEmoji("✅").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("setup:edit").setLabel("แก้ไข").setEmoji("✏️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("setup:cancel").setLabel("ยกเลิก").setEmoji("❌").setStyle(ButtonStyle.Danger)
      );

      await interaction.reply({
        ephemeral: true,
        embeds: [setupPreview(session)],
        components: [row]
      });
      return;
    }

    if (interaction.isRoleSelectMenu() && interaction.customId === "setup:role") {
      if (!(await requireAdmin(interaction))) return;

      const key = setupSessionKey(interaction.user.id, interaction.guild.id);
      const session = setupSessions.get(key);
      if (!session) {
        await interaction.reply({ ephemeral: true, embeds: [errorEmbed("Setup หมดอายุ", "กรุณาเริ่ม /setup ใหม่")] });
        return;
      }

      const role = interaction.guild.roles.cache.get(interaction.values[0]);
      if (!role) {
        await interaction.reply({ ephemeral: true, embeds: [errorEmbed("ไม่พบยศ", "ยศนี้อาจถูกลบไปแล้ว")] });
        return;
      }

      if (!canManageRole(interaction.guild, role)) {
        await interaction.reply({
          ephemeral: true,
          embeds: [errorEmbed("ไม่สามารถใช้ยศนี้ได้", "ยศต้องอยู่ต่ำกว่ายศสูงสุดของ Bot และ Bot ต้องมี Manage Roles")]
        });
        return;
      }

      session.roleId = role.id;
      session.step = "channel";

      await interaction.update({
        embeds: [infoEmbed("📍 เลือกห้องระบบรับยศ", "เลือกห้องที่ต้องการส่ง Verification Panel")],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId("setup:channel")
              .setPlaceholder("📍 เลือกห้อง")
              .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          )
        ]
      });
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === "setup:channel") {
      if (!(await requireAdmin(interaction))) return;

      const key = setupSessionKey(interaction.user.id, interaction.guild.id);
      const session = setupSessions.get(key);
      if (!session) {
        await interaction.reply({ ephemeral: true, embeds: [errorEmbed("Setup หมดอายุ", "กรุณาเริ่ม /setup ใหม่")] });
        return;
      }

      const channel = interaction.guild.channels.cache.get(interaction.values[0]);

      if (!channel || !canUseChannel(interaction.guild, channel)) {
        await interaction.reply({
          ephemeral: true,
          embeds: [errorEmbed("Permission ไม่เพียงพอ", "Bot ต้องมี View Channel, Send Messages และ Embed Links ในห้องนี้")]
        });
        return;
      }

      session.channelId = channel.id;
      session.step = "final";

      await interaction.update({
        embeds: [setupPreview(session)],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("setup:deploy").setLabel("ส่งระบบ").setEmoji("🚀").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("setup:edit").setLabel("แก้ไข").setEmoji("✏️").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("setup:cancel").setLabel("ยกเลิก").setEmoji("❌").setStyle(ButtonStyle.Danger)
          )
        ]
      });
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === "setlog:channel") {
      if (!(await requireAdmin(interaction))) return;

      const channel = interaction.guild.channels.cache.get(interaction.values[0]);

      if (!channel || !canUseChannel(interaction.guild, channel)) {
        await interaction.reply({
          ephemeral: true,
          embeds: [errorEmbed("Permission ไม่เพียงพอ", "Bot ต้องมี View Channel, Send Messages และ Embed Links ในห้องนี้")]
        });
        return;
      }

      const config = getGuildConfig(interaction.guild.id);
      config.logChannelId = channel.id;
      saveData();

      await interaction.update({
        embeds: [successEmbed("ตั้งค่าระบบ Log สำเร็จ", `📍 ห้อง Log: ${channel}`)],
        components: []
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "verify:start") {
      await interaction.deferReply({ ephemeral: true });
      await interaction.editReply({
        embeds: [infoEmbed("🔓 กำลังเริ่ม...", "กำลังตรวจสอบสถานะสมาชิก")]
      });
      await startPuzzle(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("puzzle:")) {
      const [, sessionId, index] = interaction.customId.split(":");
      await handlePuzzle(interaction, sessionId, index);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("verify:retry:")) {
      await interaction.deferUpdate();
      await interaction.editReply({
        embeds: [infoEmbed("🔄 กำลังเริ่มใหม่...", "กำลังสร้าง Puzzle ใหม่")]
      });
      await startPuzzle(interaction);
      return;
    }


    if (interaction.isButton() && interaction.customId === "setup:confirm") {
      const key = setupSessionKey(interaction.user.id, interaction.guild.id);
      const session = setupSessions.get(key);

      if (!session) {
        await interaction.reply({ ephemeral: true, embeds: [errorEmbed("Setup หมดอายุ", "กรุณาเริ่ม /setup ใหม่")] });
        return;
      }

      session.step = "role";

      await interaction.update({
        embeds: [infoEmbed("🪪 เลือกยศสมาชิก", "เลือกยศที่สมาชิกจะได้รับหลังผ่านการยืนยันตัวตน")],
        components: [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId("setup:role")
              .setPlaceholder("🪪 เลือกยศ")
              .setMinValues(1)
              .setMaxValues(1)
          )
        ]
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "setup:edit") {
      const key = setupSessionKey(interaction.user.id, interaction.guild.id);
      const session = setupSessions.get(key);

      if (!session) {
        await interaction.reply({ ephemeral: true, embeds: [errorEmbed("Setup หมดอายุ", "กรุณาเริ่ม /setup ใหม่")] });
        return;
      }

      await interaction.showModal(setupModal(session));
      return;
    }

    if (interaction.isButton() && interaction.customId === "setup:cancel") {
      cleanupSetup(setupSessionKey(interaction.user.id, interaction.guild.id));

      await interaction.update({
        embeds: [infoEmbed("❌ ยกเลิกการตั้งค่า", "Setup Session ถูกล้างเรียบร้อยแล้ว")],
        components: []
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "setup:deploy") {
      const key = setupSessionKey(interaction.user.id, interaction.guild.id);
      const session = setupSessions.get(key);

      if (!session || !session.roleId || !session.channelId) {
        await interaction.reply({ ephemeral: true, embeds: [errorEmbed("ข้อมูลไม่ครบ", "กรุณาตั้งค่าให้ครบก่อนส่งระบบ")] });
        return;
      }

      const config = getGuildConfig(interaction.guild.id);
      const channel = interaction.guild.channels.cache.get(session.channelId);
      const role = interaction.guild.roles.cache.get(session.roleId);

      if (!channel || !role || !canUseChannel(interaction.guild, channel) || !canManageRole(interaction.guild, role)) {
        await interaction.update({
          embeds: [errorEmbed("ไม่สามารถส่งระบบได้", "กรุณาตรวจสอบ Channel Permission และลำดับ Role ของ Bot")],
          components: []
        });
        return;
      }

      config.embed = { ...session.embed };
      config.roleId = session.roleId;
      config.channelId = session.channelId;

      const panel = {
        embeds: [buildCustomPanelEmbed(config)],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("verify:start")
              .setLabel("รับยศสมาชิก")
              .setEmoji("🔓")
              .setStyle(ButtonStyle.Success)
          )
        ]
      };

      let message;

      try {
        if (config.panelMessageId) {
          const old = await channel.messages.fetch(config.panelMessageId).catch(() => null);
          if (old) {
            message = await old.edit(panel);
          }
        }

        if (!message) {
          message = await channel.send(panel);
        }

        config.panelMessageId = message.id;
        saveData();
        cleanupSetup(key);

        await interaction.update({
          embeds: [successEmbed("ส่งระบบรับยศสำเร็จ", `ระบบถูกส่งไปยัง ${channel}`)
            .addFields(
              { name: "🪪 ยศ", value: `${role}`, inline: true },
              { name: "📍 ห้อง", value: `${channel}`, inline: true }
            )],
          components: []
        });
      } catch (err) {
        console.error("Panel deploy error:", err.message);
        await interaction.update({
          embeds: [errorEmbed("ส่งระบบไม่สำเร็จ", "Bot ไม่สามารถส่งหรือแก้ไข Verification Panel ได้")],
          components: []
        });
      }
      return;
    }


    if (interaction.isButton() && interaction.customId === "setupedit:embed") {
      if (!(await requireAdmin(interaction))) return;

      const config = getGuildConfig(interaction.guild.id);
      const key = setupSessionKey(interaction.user.id, interaction.guild.id);

      setupSessions.set(key, {
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        step: "edit",
        createdAt: Date.now(),
        embed: { ...config.embed },
        roleId: config.roleId,
        channelId: config.channelId
      });

      await interaction.showModal(setupModal(setupSessions.get(key)));
      return;
    }

    if (interaction.isButton() && interaction.customId === "setupedit:role") {
      if (!(await requireAdmin(interaction))) return;

      await interaction.reply({
        ephemeral: true,
        embeds: [infoEmbed("🪪 เปลี่ยนยศ", "เลือกยศใหม่")],
        components: [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId("setupedit:role-select")
              .setPlaceholder("🪪 เลือกยศ")
          )
        ]
      });
      return;
    }

    if (interaction.isRoleSelectMenu() && interaction.customId === "setupedit:role-select") {
      if (!(await requireAdmin(interaction))) return;

      const role = interaction.guild.roles.cache.get(interaction.values[0]);

      if (!role || !canManageRole(interaction.guild, role)) {
        await interaction.update({
          embeds: [errorEmbed("ไม่สามารถใช้ยศนี้ได้", "ตรวจสอบลำดับยศและ Manage Roles ของ Bot")],
          components: []
        });
        return;
      }

      const config = getGuildConfig(interaction.guild.id);
      config.roleId = role.id;
      saveData();

      await interaction.update({
        embeds: [successEmbed("เปลี่ยนยศสำเร็จ", `ยศใหม่คือ ${role}`)],
        components: []
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "setupedit:channel") {
      if (!(await requireAdmin(interaction))) return;

      await interaction.reply({
        ephemeral: true,
        embeds: [infoEmbed("📍 เปลี่ยนห้อง", "เลือกห้องใหม่สำหรับ Verification Panel")],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId("setupedit:channel-select")
              .setPlaceholder("📍 เลือกห้อง")
              .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          )
        ]
      });
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === "setupedit:channel-select") {
      if (!(await requireAdmin(interaction))) return;

      const channel = interaction.guild.channels.cache.get(interaction.values[0]);

      if (!channel || !canUseChannel(interaction.guild, channel)) {
        await interaction.update({
          embeds: [errorEmbed("Permission ไม่เพียงพอ", "Bot ต้องมี View Channel, Send Messages และ Embed Links")],
          components: []
        });
        return;
      }

      const config = getGuildConfig(interaction.guild.id);
      config.channelId = channel.id;
      saveData();

      await interaction.update({
        embeds: [successEmbed("เปลี่ยนห้องสำเร็จ", `ห้องใหม่คือ ${channel}`)],
        components: []
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "setupedit:delete") {
      if (!(await requireAdmin(interaction))) return;

      await interaction.update({
        embeds: [warningEmbed("⚠️ ยืนยันการลบระบบ", "การดำเนินการนี้จะปิดระบบรับยศของ Server")],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("setupdelete:confirm").setLabel("ยืนยันลบ").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("setupdelete:cancel").setLabel("ยกเลิก").setEmoji("❌").setStyle(ButtonStyle.Secondary)
          )
        ]
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "setupdelete:confirm") {
      if (!(await requireAdmin(interaction))) return;

      const config = getGuildConfig(interaction.guild.id);

      if (config.channelId && config.panelMessageId) {
        const channel = interaction.guild.channels.cache.get(config.channelId);
        if (channel) {
          const msg = await channel.messages.fetch(config.panelMessageId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }
      }

      delete db.guilds[interaction.guild.id];
      saveData();

      await interaction.update({
        embeds: [successEmbed("ลบระบบสำเร็จ", "ระบบรับยศถูกปิดและลบการตั้งค่าแล้ว")],
        components: []
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "setupdelete:cancel") {
      await interaction.update({
        embeds: [infoEmbed("ยกเลิกการลบ", "ระบบรับยศยังคงทำงานตามปกติ")],
        components: []
      });
      return;
    }


    if (interaction.isButton() && interaction.customId === "setlog:disable") {
      if (!(await requireAdmin(interaction))) return;

      const config = getGuildConfig(interaction.guild.id);
      config.logChannelId = null;
      saveData();

      await interaction.update({
        embeds: [successEmbed("ปิดระบบ Log สำเร็จ", "Bot จะไม่ส่ง Verification Log ไปยังห้องใด")],
        components: []
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "log:close") {
      await interaction.update({
        embeds: [infoEmbed("ปิด Dashboard", "ปิดหน้าต่าง Dashboard เรียบร้อยแล้ว")],
        components: []
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "log:dashboard") {
      if (!(await requireAdmin(interaction))) return;

      await interaction.update({
        embeds: [dashboardEmbed(interaction.guild)],
        components: [dashboardButtons()]
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "log:refresh") {
      if (!(await requireAdmin(interaction))) return;

      await interaction.update({
        embeds: [dashboardEmbed(interaction.guild)],
        components: [dashboardButtons()]
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "log:stats") {
      if (!(await requireAdmin(interaction))) return;

      const records = db.history.filter(x => x.guildId === interaction.guild.id);
      const success = records.filter(x => x.result === "success");
      const failed = records.filter(x => x.result === "failed");
      const avg = success.length
        ? success.reduce((s, x) => s + (x.completionTime || 0), 0) / success.length
        : 0;
      const rate = records.length ? success.length / records.length * 100 : 0;

      await interaction.update({
        embeds: [
          infoEmbed("สถิติการยืนยันตัวตน", "สถิติจาก Verification History")
            .addFields(
              { name: "👥 ทั้งหมด", value: String(records.length), inline: true },
              { name: "✅ สำเร็จ", value: String(success.length), inline: true },
              { name: "❌ ล้มเหลว", value: String(failed.length), inline: true },
              { name: "📈 Success Rate", value: `${rate.toFixed(1)}%`, inline: true },
              { name: "⏱️ เวลาเฉลี่ย", value: avg ? `${avg.toFixed(2)} วินาที` : "-", inline: true }
            )
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("log:dashboard").setLabel("กลับ").setEmoji("🔙").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("log:close").setLabel("ปิด").setEmoji("❌").setStyle(ButtonStyle.Danger)
          )
        ]
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("log:members:")) {
      if (!(await requireAdmin(interaction))) return;

      const page = Number(interaction.customId.split(":")[2]) || 0;
      const records = db.history.filter(x => x.guildId === interaction.guild.id && x.result === "success");
      const totalPages = Math.max(1, Math.ceil(records.length / 10));

      await interaction.update({
        embeds: [membersEmbed(interaction.guild, page)],
        components: [membersButtons(Math.min(page, totalPages - 1), totalPages)]
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("log:recent:")) {
      if (!(await requireAdmin(interaction))) return;

      const page = Number(interaction.customId.split(":")[2]) || 0;
      const records = db.history.filter(x => x.guildId === interaction.guild.id);
      const totalPages = Math.max(1, Math.ceil(records.length / 8));

      await interaction.update({
        embeds: [recentEmbed(interaction.guild, page)],
        components: [paginationButtons("log:recent", Math.min(page, totalPages - 1), totalPages)]
      });
      return;
    }

  } catch (err) {
    console.error("Interaction error:", err.message);

    try {
      const payload = {
        ephemeral: true,
        embeds: [errorEmbed("เกิดข้อผิดพลาด", "ระบบพบข้อผิดพลาดที่ไม่คาดคิด กรุณาลองใหม่อีกครั้ง")]
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch {}
  }
});


const healthServer = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ status: "not_found" }));
});

healthServer.on("error", err => {
  console.error("Health server error:", err.message);
});


setInterval(() => {
  const now = Date.now();

  for (const [userId, session] of puzzleSessions) {
    if (session.expiresAt <= now) cleanupPuzzle(userId);
  }

  for (const [key, session] of setupSessions) {
    if (now - session.createdAt > SETUP_TTL) cleanupSetup(key);
  }

  cleanupCooldowns();
}, 30_000).unref();


loadData();

healthServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Health server listening on port ${PORT}`);

  if (missingVars.length > 0) {
    console.error(`Missing required environment variables: ${missingVars.join(", ")}`);
    console.error("Set them in your hosting dashboard (e.g. Render > Environment) and redeploy.");
    process.exit(1);
    return;
  }

  client.login(TOKEN).catch(err => {
    console.error("Discord login failed:", err.message);
    if (String(err.message).toLowerCase().includes("disallowed intents")) {
      console.error(
        "-> Fix: go to https://discord.com/developers/applications > your app > Bot, " +
        "and enable 'SERVER MEMBERS INTENT' under Privileged Gateway Intents, then redeploy."
      );
    }
    process.exit(1);
  });
});

process.on("unhandledRejection", err => {
  console.error("Unhandled promise rejection:", err instanceof Error ? err.stack : err);
});

process.on("uncaughtException", err => {
  console.error("Uncaught exception:", err.stack || err.message);
});

process.on("SIGTERM", () => {
  for (const userId of puzzleSessions.keys()) cleanupPuzzle(userId);
  healthServer.close();
  client.destroy();
  process.exit(0);
});

process.on("SIGINT", () => {
  for (const userId of puzzleSessions.keys()) cleanupPuzzle(userId);
  healthServer.close();
  client.destroy();
  process.exit(0);
});
