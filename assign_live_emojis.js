require('dotenv').config();
const fs = require('fs');
const notion = require('./notion');

function getEmojiForHabit(name) {
  const n = name.toLowerCase();
  if (n.includes('abs') || n.includes('training') || n.includes('gym')) return { hexcode: "1F3CB", emoji: "🏋️" };
  if (n.includes('cyber') || n.includes('skill')) return { hexcode: "1F4BB", emoji: "💻️" };
  if (n.includes('athkar') || n.includes('quran') || n.includes('salat') || n.includes('shaf') || n.includes('water') || n.includes('subeh') || n.includes('asr') || n.includes('duhr') || n.includes('fajr') || n.includes('ishaa') || n.includes('maghrib')) return { hexcode: "1F64F", emoji: "🙏" };
  if (n.includes('language')) return { hexcode: "1F4D6", emoji: "📖" };
  if (n.includes('job') || n.includes('work')) return { hexcode: "1F4BB", emoji: "💻️" };
  if (n.includes('reading') || n.includes('book')) return { hexcode: "1F4DA", emoji: "📚️" };
  if (n.includes('sleeping')) return { hexcode: "1F4A4", emoji: "💤" };
  if (n.includes('typing')) return { hexcode: "270D", emoji: "✍️" };
  
  return { hexcode: "2728", emoji: "✨" };
}

async function run() {
  const schema = await notion.loadSchema();
  const habits = schema.habitProps.map(h => h.name);
  
  const emojiStore = {};
  const slotOrder = {};
  
  habits.forEach((habit, i) => {
    emojiStore[habit] = getEmojiForHabit(habit);
    slotOrder[habit] = i; 
  });
  
  fs.writeFileSync('emoji.json', JSON.stringify(emojiStore, null, 2));
  fs.writeFileSync('slot-order.json', JSON.stringify(slotOrder, null, 2));
  console.log("Updated files.");
}

run();
