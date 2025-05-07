import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env } from 'cloudflare:workers'

function getEnv<Env>() {
	return env as Env
}

const env2 = getEnv<Env>()
console.log(`env2: ${JSON.stringify(env2)}`)

// Define our MCP agent with tools
export interface Env {
  DB: D1Database;
  AI: Ai;
}

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Authless Calculator",
    version: "1.0.0",
  });

  async init() {
    // Simple addition tool
    this.server.tool(
      "add",
      { a: z.number(), b: z.number() },
      async ({ a, b }) => ({
        content: [{ type: "text", text: String(a + b) }],
      })
    );

    // Calculator tool with multiple operations
    this.server.tool(
      "calculate",
      {
        operation: z.enum(["add", "subtract", "multiply", "divide"]),
        a: z.number(),
        b: z.number(),
      },
      async ({ operation, a, b }) => {
        let result: number;
        switch (operation) {
          case "add":
            result = a + b;
            break;
          case "subtract":
            result = a - b;
            break;
          case "multiply":
            result = a * b;
            break;
          case "divide":
            if (b === 0)
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: Cannot divide by zero",
                  },
                ],
              };
            result = a / b;
            break;
        }
        return { content: [{ type: "text", text: String(result) }] };
      }
    );

    // Book search tool
    this.server.tool(
      "searchBooks",
      { 
        query: z.string(),
        sortBy: z.enum(['avg_rating', 'title', 'author']).optional(),
        minRating: z.number().min(0).max(5).optional(),
        maxRating: z.number().min(0).max(5).optional(),
        limit: z.number().min(1).max(20).optional(),
        bookshelf: z.string().optional()
      },
      async ({ query, sortBy = 'avg_rating', minRating, maxRating, limit = 5, bookshelf }) => {
        const env = getEnv<Env>();
        
        // Check query type
        const isTopRatedQuery = query.toLowerCase().includes('top') && 
                              (query.toLowerCase().includes('rated') || query.toLowerCase().includes('rating'));
        const isRecommendationQuery = query.toLowerCase().includes('recommend') || 
                                    query.toLowerCase().includes('similar to') ||
                                    query.toLowerCase().includes('like');
        const isAuthorQuery = query.toLowerCase().includes('by') || 
                            query.toLowerCase().includes('author');

        // Build the SQL query
        let sqlQuery = "SELECT title, author, avg_rating, bookshelves FROM btable";
        const conditions = [];
        const params = [];

        // Add search conditions
        if (!isTopRatedQuery) {
          if (isAuthorQuery) {
            conditions.push("author LIKE ?");
            params.push(`%${query}%`);
          } else {
            conditions.push("(title LIKE ? OR author LIKE ? OR bookshelves LIKE ?)");
            params.push(`%${query}%`, `%${query}%`, `%${query}%`);
          }
        }

        // Add rating range conditions
        if (minRating !== undefined) {
          conditions.push("avg_rating >= ?");
          params.push(minRating);
        }
        if (maxRating !== undefined) {
          conditions.push("avg_rating <= ?");
          params.push(maxRating);
        }

        // Add bookshelf condition
        if (bookshelf) {
          conditions.push("bookshelves LIKE ?");
          params.push(`%${bookshelf}%`);
        }

        // Combine conditions
        if (conditions.length > 0) {
          sqlQuery += " WHERE " + conditions.join(" AND ");
        }

        // Add sorting
        sqlQuery += ` ORDER BY ${sortBy} ${sortBy === 'avg_rating' ? 'DESC' : 'ASC'}`;

        // Add limit
        sqlQuery += ` LIMIT ${limit}`;

        // Log the query for debugging
        console.log('SQL Query:', sqlQuery);
        console.log('Params:', params);

        // Execute query
        const { results } = await env.DB.prepare(sqlQuery)
          .bind(...params)
          .all();

        // Prepare the context for the LLM
        const context = results.map((book: any) => `
          Title: ${book.title}
          Author: ${book.author}
          Rating: ${book.avg_rating}
          Bookshelf: ${book.bookshelves}
        `).join('\n\n');

        // Prepare the prompt based on query type
        let prompt;
        if (isTopRatedQuery) {
          prompt = `Here are the top ${limit} highest rated books:
${context}

Please list these books in order of their average ratings, showing the title, author, and rating for each.`;
        } else if (isRecommendationQuery) {
          prompt = `Based on the search query "${query}", here are some recommended books:
${context}

Please provide a brief summary of each book, focusing on why it might be similar to or recommended based on the query. Include the title, author, and average rating for each.`;
        } else if (isAuthorQuery) {
          prompt = `Here are books by the author matching "${query}":
${context}

Please list these books, showing the title, average rating, and bookshelf for each.`;
        } else {
          prompt = `Here are some relevant books I found for "${query}":
${context}

Please provide a brief summary of each book, focusing on the title, author, and average rating. If there are multiple books, highlight the ones with the highest ratings.`;
        }

        // Call the LLM with the context
        const messages = [
          { role: "system", content: "You are a helpful assistant that provides detailed information about books. Focus on providing comprehensive summaries that include title, author, average rating, and relevant context." },
          { role: "user", content: prompt },
        ];

        const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages });

        return {
          content: [
            {
              type: "text",
              text: typeof response === 'string' ? response : JSON.stringify(response),
            },
          ],
        };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      // @ts-ignore
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      // @ts-ignore
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
