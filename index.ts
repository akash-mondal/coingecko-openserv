import 'dotenv/config';

import { getTools, type ToolBase } from '@goat-sdk/core';
import { coingecko } from '@goat-sdk/plugin-coingecko'; // Import CoinGecko plugin
import { Agent, type Capability } from '@openserv-labs/sdk';
import { z } from 'zod';
import { createWalletClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { viem } from '@goat-sdk/wallet-viem';
// Import OpenAI (needed for intercepting the request)
import OpenAI from 'openai';

if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
}

if (!process.env.OPENSERV_API_KEY) {
    throw new Error('OPENSERV_API_KEY is not set');
}

if (!process.env.RPC_PROVIDER_URL) {
  throw new Error('RPC_PROVIDER_URL is not set');
}

if (!process.env.COINGECKO_API_KEY) {
  throw new Error('COINGECKO_API_KEY is not set');
}

const systemPrompt = `
You are a helpful AI assistant that retrieves cryptocurrency information from CoinGecko.

You have the following capabilities:

*   **coingecko_get_trending_coins:**  Gets a list of currently trending coins (top searches, NFTs, and categories) on CoinGecko.
*   **coingecko_get_coin_prices:** Gets the current prices for specified coins in various currencies.
*   **coingecko_search_coins:** Searches for coins, categories, and exchanges by name or symbol.
*   **coingecko_get_coin_price_by_contract_address:** Gets the current price and other basic market data for a token using its contract address.
*   **coingecko_get_historical_data:** Get historical price data for a specific date.
*   **coingecko_get_trending_coin_categories:** Get trending coins within specific categories.
*   **coingecko_coin_categories:** Get a list of all coin categories.
*   **coingecko_get_ohlc_data:** Get OHLC (Open-High-Low-Close) market data.
`;

// Map to store original tool names
const toolNameMap = new Map();

const coinagent = new Agent({
    systemPrompt,
    apiKey: process.env.OPENSERV_API_KEY,
});

const formatToolName = (name) => {
    // Replace dots with underscores to match the required pattern
    return name.replace(/\./g, '_');
};

async function main() {
    const dummyWalletClient = createWalletClient({
        chain: mainnet, // Use mainnet chain definition.
        transport: http(process.env.RPC_PROVIDER_URL), // Use a basic HTTP transport
    }) as any;

    const wallet = viem(dummyWalletClient);

    const allTools = await getTools({
        wallet, // Keep the wallet setup
        plugins: [
            coingecko({ 
                apiKey: process.env.COINGECKO_API_KEY 
                // Add isPro: true if you want to use Pro API features
            })
        ],
    });

    // Print all available tools with description lengths
    console.log("=== All Available Tools with Description Lengths ===");
    allTools.forEach((tool, index) => {
        const descLength = tool.description ? tool.description.length : 0;
        console.log(`[${index}] Tool Name: ${tool.name}`);
        console.log(`Description Length: ${descLength}`);
        
        // Flag long descriptions that might cause issues
        if (descLength > 1000) {
            console.log("⚠️ LONG DESCRIPTION WARNING ⚠️");
            console.log(`Description: ${tool.description}`);
        }
        console.log('---');
    });


    const tools = allTools.filter(tool => !tool.name.includes('get_chain'));

    
    
    console.log(`Filtered out coingecko.get_coin_data, remaining tools: ${tools.length}`);

    // Check for long descriptions before creating capabilities
    console.log("\n=== Checking for long descriptions (>1000 chars) ===");
    tools.forEach((tool, index) => {
        const descLength = tool.description ? tool.description.length : 0;
        if (descLength > 1000) {
            console.log(`Tool index ${index}, name ${tool.name} has description length ${descLength}`);
            // Truncate long descriptions to avoid errors
            tool.description = tool.description.substring(0, 1000) + "... (truncated)";
            console.log(`Description truncated to: ${tool.description.length} chars`);
        }
    });

    // Store original tools by their formatted names for lookup during execution
    tools.forEach(tool => {
        const formattedName = formatToolName(tool.name);
        toolNameMap.set(formattedName, tool);
    });

    const toCapability = (tool: ToolBase) => {
        // Create a formatted name that follows OpenAI's allowed pattern
        const formattedName = formatToolName(tool.name);
        
        return {
            name: formattedName, // Use formatted name for OpenAI
            description: tool.description,
            schema: tool.parameters,
            async run({ args }) {
                try {
                    // Use the original tool for execution
                    const originalTool = toolNameMap.get(formattedName);
                    if (!originalTool) {
                        throw new Error(`Original tool not found for ${formattedName}`);
                    }
                    
                    const response = await originalTool.execute(args);
                    if (typeof response === 'object') {
                        return JSON.stringify(response, null, 2);
                    }
                    return response.toString();
                } catch (error) {
                    console.error(`Error in capability ${formattedName}:`, error);
                    return `An error occurred while running ${formattedName}: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            },
        } as Capability<typeof tool.parameters>;
    };

    const capabilities = tools.map(toCapability);
    console.log(`Created ${capabilities.length} capabilities`);

    try {
        await coinagent.addCapabilities(capabilities as [
            Capability<z.ZodTypeAny>,
            ...Capability<z.ZodTypeAny>[]
        ]);
        console.log(`Successfully added ${capabilities.length} capabilities to agent`);

        // --- INTERCEPTING AND LOGGING THE OPENAI REQUEST ---
        const originalCreateChatCompletion = coinagent.openai.chat.completions.create.bind(coinagent.openai.chat.completions);

        coinagent.openai.chat.completions.create = async function (
            ...args: Parameters<typeof originalCreateChatCompletion>
        ): ReturnType<typeof originalCreateChatCompletion> {
            const [body, ...rest] = args; // Extract the body (first argument)
            if (body && 'tools' in body) {
                console.log("--- OpenAI Request (Tools): ---");
                // Check for long descriptions in the request
                body.tools.forEach((tool, index) => {
                    if (tool.function && tool.function.description) {
                        const descLength = tool.function.description.length;
                        if (descLength > 1000) {
                            console.log(`⚠️ Tool at index ${index} has description length ${descLength}`);
                        }
                    }
                });
            }
            // Call the original function with all arguments
            return originalCreateChatCompletion(...args);
        } as typeof originalCreateChatCompletion;

        console.log("CoinGecko agent is ready with all tools except get_coin_data");

    } catch (error) {
        console.error("Error adding capabilities:", error);
    }
}

coinagent.start().then(() => {
    console.log("Agent server started");
    main().catch(err => {
        console.error("Error in main:", err);
    });
}).catch(err => {
    console.error("Failed to start agent:", err);
});
