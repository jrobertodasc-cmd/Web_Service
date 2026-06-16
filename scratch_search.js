const fs = require('fs');
const readline = require('readline');

const logPath = 'C:\\Users\\Roberto\\.gemini\\antigravity\\brain\\bbcd723a-eae6-4fa6-b7af-1ed0886791fd\\.system_generated\\logs\\transcript.jsonl';

const lines = [];

const rl = readline.createInterface({
    input: fs.createReadStream(logPath),
    output: process.stdout,
    terminal: false
});

rl.on('line', (line) => {
    try {
        const obj = JSON.parse(line);
        if (obj.type === 'USER_INPUT' || obj.type === 'PLANNER_RESPONSE') {
            lines.push(obj);
        }
    } catch (e) {}
});

rl.on('close', () => {
    let targetIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const contentStr = lines[i].content ? String(lines[i].content) : '';
        if (contentStr.toLowerCase().includes('sermos mais eficiente') || contentStr.toLowerCase().includes('sermos mais eficientes')) {
            targetIdx = i;
            break;
        }
    }

    if (targetIdx !== -1) {
        console.log(`Found target at index ${targetIdx}`);
        const start = Math.max(0, targetIdx - 3);
        const end = Math.min(lines.length, targetIdx + 10);
        for (let i = start; i < end; i++) {
            const item = lines[i];
            console.log(`\n==================================================`);
            console.log(`[${item.source}] Step ${item.step_index} (${item.type}):`);
            console.log(`==================================================`);
            console.log(item.content ? item.content.trim() : '');
        }
    } else {
        console.log('Not found');
    }
});
