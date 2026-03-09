import axios from 'axios';

const token = "8383891169:AAEMwUUhl9gl7KlvL3PJSfwTNaCZgkrBMgs";
const chatId = "7114714453"; // From config allowed IDs
// Wait, actually I can just run a script to see if the bot responds to any incoming update for that chat? No, I want to send a message to the bot from this chat, BUT I am not the user.
// I can fetch getUpdates.

async function main() {
    try {
        const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`);
        console.log("Updates:", JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.error(e);
    }
}
main();
