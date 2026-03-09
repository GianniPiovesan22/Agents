import { registerTool } from './index.js';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'take_screenshot',
            description: 'Takes a screenshot of a specific website URL, rendering the page as a real browser would. Returns the image file path.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The URL to take a screenshot of (e.g. https://www.amazon.com/...)',
                    },
                    full_page: {
                        type: 'boolean',
                        description: 'If true, takes a screenshot of the entire scrolling page. Defaults to false (only viewport).',
                    }
                },
                required: ['url'],
            },
        },
    },
    execute: async (args) => {
        try {
            console.log(`📸 Taking screenshot of: ${args.url}`);

            const browser = await puppeteer.launch({
                headless: true, // Use new headless mode
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            const page = await browser.newPage();

            // Set a standard desktop viewport
            await page.setViewport({ width: 1920, height: 1080 });

            await page.goto(args.url, { waitUntil: 'networkidle2', timeout: 30000 });

            const tmpPath = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tmpPath)) fs.mkdirSync(tmpPath, { recursive: true });

            const screenshotName = `screenshot_${Date.now()}.png`;
            const screenshotPath = path.join(tmpPath, screenshotName);

            await page.screenshot({
                path: screenshotPath,
                fullPage: args.full_page === true
            });

            await browser.close();

            const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`;

            return `Screenshot saved successfully.\nFile: ${screenshotName}\nURL: ${baseUrl}/tmp/${screenshotName}`;

        } catch (error: any) {
            return `Error taking screenshot: ${error.message}`;
        }
    },
});

console.log('🔌 Screenshot tool (Puppeteer) registered');
