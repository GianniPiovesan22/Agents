import { runAgent } from './src/agent/loop.js';

async function main() {
    const res = await runAgent('7114714453', [
        { role: 'user', content: 'www.brescopack.com que hace este sitio' }
    ]);
    console.log("Response:", res);
}
main();
