// Repro of the chat tonnage filter for "0 to 2tons" in node.
const text = ' show only digit MH06 TATA super carry between 0 to 2tons comp ';
const tonRange  = text.match(/(\d+(?:\.\d+)?)\s*(?:to|-|–)\s*(\d+(?:\.\d+)?)\s*(?:TONS?|TNS?|T)\b/i);
console.log('tonRange match:', tonRange && tonRange.slice(1, 3));

const ageRange = text.match(/(?:AGE\s*)?(\d{1,2})\s*(?:to|-|–)\s*(\d{1,2})\s*(?:YEAR|YR|Y)?\b/i);
console.log('ageRange match:', ageRange && ageRange.slice(0, 3));
