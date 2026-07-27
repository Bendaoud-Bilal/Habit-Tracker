require('dotenv').config();
const notion = require('./notion');

async function run() {
  const schema = await notion.loadSchema();
  console.log("Current habit names in Notion:");
  schema.habitProps.forEach(h => console.log(`- ${h.name}`));
}
run();
