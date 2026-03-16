#!/usr/bin/env node

import fs from "fs-extra";
import path from "path";
import { execSync } from "child_process";

// The CLI receives the SSE URL (e.g. https://archonspecs.dev/mcp/sse?apiKey=...)
const sseUrl = process.argv[2] || "https://archonspecs.dev/mcp/sse";
const authHeader = process.env.ARCHON_TOKEN
  ? `Bearer ${process.env.ARCHON_TOKEN}`
  : undefined;
const headers = authHeader
  ? { Authorization: authHeader, "Content-Type": "application/json" }
  : { "Content-Type": "application/json" };

// Calculate the POST endpoint
const postUrl = sseUrl.replace("/mcp/sse", "/mcp");

const LINEAGE_FILE = ".archon/lineage.json";
const LOCK_FILE = ".archon/sync.lock";
const SPEC_FILE = "designspec.json";

/**
 * Finds the project root by walking up from CWD
 */
function findProjectRoot(start = process.cwd()) {
  let curr = start;
  while (curr !== path.parse(curr).root) {
    if (fs.existsSync(path.join(curr, LINEAGE_FILE))) return curr;
    curr = path.dirname(curr);
  }
  return null;
}

/**
 * Checks if git workspace is dirty
 */
function isGitDirty(root) {
  try {
    const status = execSync("git status --porcelain", { cwd: root, encoding: "utf-8" });
    return status.trim().length > 0;
  } catch (e) {
    return false; // Not a git repo or git not installed
  }
}

/**
 * Lock Management
 */
function acquireLock(root) {
  const lockPath = path.join(root, LOCK_FILE);
  if (fs.existsSync(lockPath)) {
    const lock = fs.readJSONSync(lockPath);
    throw new Error(`Sync lock held by process ${lock.pid} since ${lock.startedAt}`);
  }
  fs.writeJSONSync(lockPath, { pid: process.pid, startedAt: new Date().toISOString() });
}

function releaseLock(root) {
  const lockPath = path.join(root, LOCK_FILE);
  if (fs.existsSync(lockPath)) fs.removeSync(lockPath);
}

/**
 * Handles exclusive local MCP content
 */
async function handleLocalOnly(method, params, id) {
  const root = findProjectRoot();

  if (method === "resources/read" && params?.uri === "archon://local/lineage") {
    if (root) {
      const lineagePath = path.join(root, LINEAGE_FILE);
      const content = await fs.readFile(lineagePath, "utf-8");
      return {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [{ uri: params.uri, mimeType: "application/json", text: content }]
        }
      };
    }
  }

  // Tools Implementation
  if (method === "tools/call") {
    switch (params?.name) {
      case "archon_read_local_lineage":
        if (!root) return { jsonrpc: "2.0", id, error: { code: -32000, message: "No Archon project found." } };
        const lineage = await fs.readJSON(path.join(root, LINEAGE_FILE));
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ projectRoot: root, lineage }, null, 2) }] } };

      case "archon_verify_local":
        if (!root) return { jsonrpc: "2.0", id, error: { code: -32000, message: "No Archon project found." } };
        try {
          execSync(`npx archon verify`, { cwd: root, stdio: "pipe" });
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `✅ Verification passed for project at ${root}` }] } };
        } catch (e) {
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `❌ Verification failed: ${e.message}` }], isError: true } };
        }

      case "archon_sync_local":
        if (!root) return { jsonrpc: "2.0", id, error: { code: -32000, message: "No Archon project found." } };
        
        const allowDirty = params.arguments?.allowDirtyWorkspace ?? false;
        if (!allowDirty && isGitDirty(root)) {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: "DIRTY_WORKSPACE: Workspace has uncommitted changes. Use allowDirtyWorkspace: true to override." } };
        }

        try {
          acquireLock(root);
          const lineage = await fs.readJSON(path.join(root, LINEAGE_FILE));
          const projectId = lineage.projectId || lineage.id;

          // Fetch latest approved spec
          const specRes = await (await fetch(postUrl, {
            method: "POST", headers,
            body: JSON.stringify({ 
              jsonrpc: "2.0", 
              method: "tools/call", 
              params: { name: "archon_get_current_spec", arguments: { projectId } }, 
              id: "sync_fetch" 
            })
          })).json();

          const remoteSpec = specRes.result?.structuredContent?.spec;
          const remoteRevisionId = specRes.result?.structuredContent?.revisionId;

          if (!remoteSpec) throw new Error("Could not retrieve approved spec from remote.");

          // Force generate
          await fs.writeJSON(path.join(root, SPEC_FILE), remoteSpec, { spaces: 2 });
          execSync(`npx archon generate -s ${SPEC_FILE} -o . --force --no-qa`, { cwd: root, stdio: "inherit" });

          releaseLock(root);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `✅ SYNC SUCCESS: Project moved to revision ${remoteRevisionId}.\nManual regions preserved. Lineage updated by generator.` }]
            }
          };
        } catch (e) {
          releaseLock(root);
          return { jsonrpc: "2.0", id, error: { code: -32603, message: `Sync failed: ${e.message}` } };
        }

      case "archon_diff_local":
        if (!root) return { jsonrpc: "2.0", id, error: { code: -32000, message: "No Archon project found." } };
        try {
          const lineage = await fs.readJSON(path.join(root, LINEAGE_FILE));
          const projectId = lineage.projectId || lineage.id;

          // Fetch latest approved spec
          const specRes = await (await fetch(postUrl, {
            method: "POST", headers,
            body: JSON.stringify({ 
              jsonrpc: "2.0", 
              method: "tools/call", 
              params: { name: "archon_get_current_spec", arguments: { projectId } }, 
              id: "diff_fetch" 
            })
          })).json();

          const remoteSpec = specRes.result?.structuredContent?.spec;
          if (!remoteSpec) throw new Error("Could not retrieve approved spec from remote.");

          // Force generate into a temporary file
          const tempSpecFile = path.join(root, ".archon/temp_spec.json");
          await fs.writeJSON(tempSpecFile, remoteSpec, { spaces: 2 });
          
          const output = execSync(`npx archon generate -s .archon/temp_spec.json -o . --dry-run --no-qa`, { 
            cwd: root, 
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"] 
          });

          await fs.remove(tempSpecFile);

          const created = (output.match(/Would created:/g) || []).length;
          const merged = (output.match(/Would merged:/g) || []).length;
          
          // Try to extract some file names
          const lines = output.split("\n");
          const changedFiles = lines
            .filter(l => l.includes("[DryRun] Would"))
            .map(l => l.split(": ").pop())
            .map(p => path.relative(root, p))
            .slice(0, 10);

          return { 
            jsonrpc: "2.0", 
            id, 
            result: { 
              content: [{ 
                type: "text", 
                text: `🔍 **DIFF PREVIEW**\n\n- Files to create: **${created}**\n- Files to update: **${merged}**\n\n**Example changes:**\n${changedFiles.map(f => `- ${f}`).join("\n")}${changedFiles.length >= 10 ? "\n- ..." : ""}` 
              }] 
            } 
          };
        } catch (e) {
          return { jsonrpc: "2.0", id, error: { code: -32603, message: `Diff failed: ${e.message}` } };
        }
    }
  }

  return null;
}

// Setup stdin stream
let buffer = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line);
      const root = findProjectRoot();
      const hasProject = !!root;

      // 1. Try handling locally for exclusive tools/resources
      const localResponse = await handleLocalOnly(request.method, request.params, request.id);
      if (localResponse) {
        process.stdout.write(JSON.stringify(localResponse) + "\n");
        continue;
      }

      // 2. Proxy to Remote
      const res = await fetch(postUrl, {
        method: "POST",
        headers,
        body: line,
      });

      if (!res.ok) {
        console.error("Proxy HTTP Error:", res.status, await res.text());
        continue;
      }

      const responseJson = await res.json();

      // 3. Augment / Filter Response
      if (request.method === "resources/list") {
        if (hasProject) {
          responseJson.result.resources.push({
            uri: "archon://local/lineage",
            name: "Local Archon Lineage",
            description: "CRITICAL: The immutable lineage of this project. Contains projectId and revisionId.",
            mimeType: "application/json"
          });
        }
      }

      if (request.method === "tools/list") {
        // Add Local Tools
        responseJson.result.tools.push(
          { name: "archon_read_local_lineage", description: "Read the local lineage manifest.", inputSchema: { type: "object", properties: {} } },
          { name: "archon_verify_local", description: "Verify local code integrity against lineage.", inputSchema: { type: "object", properties: {} } },
          { name: "archon_diff_local", description: "Preview changes before sync.", inputSchema: { type: "object", properties: {} } },
          { 
            name: "archon_sync_local", 
            description: "Final step of architectural change. Applies latest approved spec to current workspace.",
            inputSchema: { 
              type: "object", 
              properties: { 
                projectId: { type: "string" },
                allowDirtyWorkspace: { type: "boolean" }
              } 
            } 
          }
        );

        // PHASE FILTERING
        if (!hasProject) {
          responseJson.result.tools = responseJson.result.tools.filter(t => 
            !["archon_add_domain", "archon_add_entity", "archon_patch_spec", "archon_sync_local", "archon_diff_local", "archon_verify_local"].includes(t.name)
          );
        }
      }

      process.stdout.write(JSON.stringify(responseJson) + "\n");
    } catch (e) {
      console.error("Proxy error:", e.message);
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
