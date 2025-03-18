import 'dotenv/config';

import { getTools, type ToolBase } from '@goat-sdk/core';
import { coingecko } from '@goat-sdk/plugin-coingecko';
import { Agent, type Capability } from '@openserv-labs/sdk';
import { z } from 'zod';
import { createWalletClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { viem } from '@goat-sdk/wallet-viem';

// Validate environment variables
['OPENAI_API_KEY', 'OPENSERV_API_KEY', 'RPC_PROVIDER_URL', 'COINGECKO_API_KEY'].forEach((key) => {
    if (!process.env[key]) {
        throw new Error(`${key} is not set`);
    }
});

const systemPrompt = `
You are a helpful AI assistant that retrieves cryptocurrency information from CoinGecko.

You have the following capabilities:

* **coingecko_get_trending_coins:** Gets a list of currently trending coins.
* **coingecko_get_coin_prices:** Gets the current prices for specified coins.
* **coingecko_search_coins:** Searches for coins, categories, and exchanges.
* **coingecko_get_coin_price_by_contract_address:** Gets price data using a contract address.
* **coingecko_get_historical_data:** Get historical price data for a specific date.
* **coingecko_get_trending_coin_categories:** Get trending coins within specific categories.
* **coingecko_coin_categories:** Get a list of all coin categories.
* **coingecko_get_ohlc_data:** Get OHLC (Open-High-Low-Close) market data.
`;

const toolNameMap = new Map();

const coinagent = new Agent({
    systemPrompt,
    apiKey: process.env.OPENSERV_API_KEY,
});

const formatToolName = (name: string) => name.replace(/\./g, '_');

async function main() {
    const dummyWalletClient = createWalletClient({
        chain: mainnet,
        transport: http(process.env.RPC_PROVIDER_URL),
    }) as any;

    const wallet = viem(dummyWalletClient);

    const allTools = await getTools({
        wallet,
        plugins: [
            coingecko({
                apiKey: process.env.COINGECKO_API_KEY,
            }),
        ],
    });

    console.log("=== Available Tools ===");
    allTools.forEach((tool, index) => {
        console.log(`[${index}] Tool Name: ${tool.name}`);
        if (tool.description && tool.description.length > 1000) {
            console.log("⚠️ LONG DESCRIPTION WARNING ⚠️");
            tool.description = tool.description.substring(0, 1000) + "... (truncated)";
        }
    });

    const tools = allTools.filter(tool => !tool.name.includes('get_chain'));
    console.log(`Filtered tools: ${tools.length}`);

    tools.forEach(tool => {
        const formattedName = formatToolName(tool.name);
        toolNameMap.set(formattedName, tool);
    });

    const toCapability = (tool: ToolBase) => {
        const formattedName = formatToolName(tool.name);
        return {
            name: formattedName,
            description: tool.description,
            schema: tool.parameters,
            async run({ args }) {
                try {
                    const originalTool = toolNameMap.get(formattedName);
                    if (!originalTool) throw new Error(`Tool not found: ${formattedName}`);
                    const response = await originalTool.execute(args);
                    return typeof response === 'object' ? JSON.stringify(response, null, 2) : response.toString();
                } catch (error) {
                    console.error(`Error in ${formattedName}:`, error);
                    return `Error running ${formattedName}: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            },
        } as Capability<typeof tool.parameters>;
    };

    const capabilities = tools.map(toCapability);
    console.log(`Adding ${capabilities.length} capabilities to agent`);

    try {
        await coinagent.addCapabilities(capabilities as [Capability<z.ZodTypeAny>, ...Capability<z.ZodTypeAny>[]]);
        console.log("Capabilities added successfully");

        coinagent.start().then(() => {
            console.log("Agent server started");
        }).catch(err => {
            console.error("Failed to start agent:", err);
        });
    } catch (error) {
        console.error("Error adding capabilities:", error);
    }
}

main().catch(err => {
    console.error("Error in main:", err);
});
