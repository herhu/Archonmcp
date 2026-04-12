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
const REGIONS_START_REGEX = /\/\/\s*@archon-manual-start:(\S+)/g;
const REGIONS_END_REGEX = /\/\/\s*@archon-manual-end/g;

/**
 * Region Management (extracted from Archon Core)
 */
function extractRegions(content) {
  const regions = new Map();
  let match;

  // 1. Comment-based
  REGIONS_START_REGEX.lastIndex = 0;
  while ((match = REGIONS_START_REGEX.exec(content)) !== null) {
    const id = match[1];
    const startIdx = match.index + match[0].length;
    REGIONS_END_REGEX.lastIndex = startIdx;
    const endMatch = REGIONS_END_REGEX.exec(content);
    if (endMatch) {
      regions.set(id, content.substring(startIdx, endMatch.index));
      REGIONS_START_REGEX.lastIndex = endMatch.index + endMatch[0].length;
    }
  }

  // 2. Decorator-based
  const decoratorRegex = /@ArchonManual\(\)\s*(?:async\s+)?(\w+)\s*\(/g;
  let decoMatch;
  while ((decoMatch = decoratorRegex.exec(content)) !== null) {
    const methodName = decoMatch[1];
    const decoratorStart = decoMatch.index;
    const bodyStartIdx = content.indexOf('{', decoMatch.index);
    if (bodyStartIdx !== -1) {
      const bodyEndIdx = findClosingBrace(content, bodyStartIdx);
      if (bodyEndIdx !== -1) {
        const fullBlock = content.substring(decoratorStart, bodyEndIdx + 1);
        regions.set(`decorator:${methodName}`, fullBlock);
        decoratorRegex.lastIndex = bodyEndIdx + 1;
      }
    }
  }

  return regions;
}

function findClosingBrace(content, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function mergeRegions(oldContent, newContent, filePath = "") {
  const oldRegions = extractRegions(oldContent);
  if (oldRegions.size === 0) return newContent;
  let merged = newContent;
  let mergedCount = 0;

  for (const [id, content] of oldRegions.entries()) {
    let isMerged = false;

    if (id.startsWith('decorator:')) {
      const methodName = id.split(':')[1];
      // Surgical Replace: find the method in the NEW content and replace it
      const methodPattern = `(?:async\\s+)?${methodName}\\s*\\([\\s\\S]*?\\)\\s*(?::\\s*[\\s\\S]*?)?\\{`;
      const methodRegex = new RegExp(methodPattern, 'g');
      
      const match = methodRegex.exec(merged);
      if (match) {
        const bodyStartIdx = match.index + match[0].length - 1; // last {
        const bodyEndIdx = findClosingBrace(merged, bodyStartIdx);
        if (bodyEndIdx !== -1) {
          const prefix = merged.substring(0, match.index);
          const suffix = merged.substring(bodyEndIdx + 1);
          merged = prefix + content + suffix;
          isMerged = true;
        }
      }

      if (!isMerged) {
        // Fallback: append to 'methods' manual region if it exists
        const methodsPattern = `(\\/\\/\\s*@archon-manual-start:methods)(\\s*[\\s\\S]*?)(\\/\\/\\s*@archon-manual-end)`;
        const methodsRegex = new RegExp(methodsPattern, 'g');
        if (methodsRegex.test(merged)) {
          merged = merged.replace(methodsRegex, (match, p1, p2, p3) => {
            if (p2.includes(content)) return match;
            return p1 + p2 + "\n" + content + "\n" + p3;
          });
          isMerged = true;
        }
      }
    } else {
      const escapedId = id.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const pattern = `(\\/\\/\\s*@archon-manual-start:${escapedId})(\\s*[\\s\\S]*?)(\\/\\/\\s*@archon-manual-end)`;
      const regex = new RegExp(pattern, 'g');
      
      if (regex.test(merged)) {
        merged = merged.replace(regex, (m, p1, p2, p3) => p1 + content + p3);
        isMerged = true;
      }
    }

    if (isMerged) {
      mergedCount++;
    } else {
      console.error(`  [WARNING] Manual region '${id}' could not be merged into ${filePath}. Target marker or method missing.`);
    }
  }

  if (mergedCount > 0) {
    console.error(`  - Merged ${mergedCount}/${oldRegions.size} manual regions in ${filePath}`);
  }

  return merged;
}

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

          // Incremental Sync
          const oldSpecPath = path.join(root, ".archon/old_spec.json");
          const localSpecPath = path.join(root, SPEC_FILE);
          if (fs.existsSync(localSpecPath)) {
            fs.copySync(localSpecPath, oldSpecPath);
          }
          
          await fs.writeJSON(localSpecPath, remoteSpec, { spaces: 2 });
          
          const output = execSync(`npx archon generate -s ${SPEC_FILE} -p .archon/old_spec.json -o . --force --no-qa --json`, { 
            cwd: root, 
            encoding: "utf-8" 
          });

          let resultData;
          try {
            resultData = JSON.parse(output.substring(output.indexOf('{')));
          } catch (e) {
            throw new Error(`Failed to parse generator output: ${output}`);
          }

          releaseLock(root);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ 
                type: "text", 
                text: `✅ SYNC SUCCESS: Project moved to revision ${remoteRevisionId}.\nMode: ${resultData.mode}\nDeltas: ${JSON.stringify(resultData.deltas)}\nCreated: ${resultData.results.created.length}, Updated: ${resultData.results.updated.length}, Skipped: ${resultData.results.skipped.length}`
              }],
              structuredContent: {
                syncResult: resultData,
                revisionId: remoteRevisionId
              }
            }
          };
        } catch (e) {
          releaseLock(root);
          return { jsonrpc: "2.0", id, error: { code: -32603, message: `Sync failed: ${e.message}` } };
        }

      case "archon_sync_via_artifact":
        if (!root) return { jsonrpc: "2.0", id, error: { code: -32000, message: "No Archon project found." } };

        const artifactUrl = params.arguments?.artifactUrl;
        if (!artifactUrl) return { jsonrpc: "2.0", id, error: { code: -32000, message: "Missing artifactUrl." } };

        const tempZip = path.join("/tmp", `archon_sync_${Date.now()}.zip`);
        const tempUnzipDir = path.join("/tmp", `archon_sync_unzip_${Date.now()}`);

        try {
          console.error(`Downloading artifact from ${artifactUrl}...`);
          execSync(`curl -L -o ${tempZip} "${artifactUrl}"`, { stdio: "inherit" });
          
          await fs.ensureDir(tempUnzipDir);
          console.error(`Unzipping to ${tempUnzipDir}...`);
          execSync(`unzip -o ${tempZip} -d ${tempUnzipDir}`, { stdio: "inherit" });
          
          // PHASE: SMART MERGE
          const files = await fs.readdir(tempUnzipDir, { recursive: true });
          for (const file of files) {
            const localFile = path.join(root, file);
            const remoteFile = path.join(tempUnzipDir, file);
            
            if (fs.existsSync(localFile) && !fs.lstatSync(localFile).isDirectory()) {
              const oldContent = await fs.readFile(localFile, "utf-8");
              const newContent = await fs.readFile(remoteFile, "utf-8");
              
              const oldRegions = extractRegions(oldContent);
              if (oldRegions.size > 0) {
                const mergedContent = mergeRegions(oldContent, newContent, file);
                if (mergedContent !== newContent) {
                  await fs.writeFile(remoteFile, mergedContent);
                }
              }
            }
          }

          console.error(`Moving merged files to ${root}...`);
          fs.copySync(tempUnzipDir, root, { overwrite: true });

          fs.removeSync(tempZip);
          fs.removeSync(tempUnzipDir);
          
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `✅ ARTIFACT SYNC SUCCESS: Files merged and overwritten from ZIP. Manual regions PRESERVED.` }]
            }
          };
        } catch (e) {
          if (fs.existsSync(tempZip)) fs.removeSync(tempZip);
          if (fs.existsSync(tempUnzipDir)) fs.removeSync(tempUnzipDir);
          return { jsonrpc: "2.0", id, error: { code: -32603, message: `Artifact sync failed: ${e.message}` } };
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

          // Diff into structured output
          const remoteSpecFile = path.join(root, ".archon/remote_spec.json");
          await fs.writeJSON(remoteSpecFile, remoteSpec, { spaces: 2 });
          
          const output = execSync(`npx archon generate -s .archon/remote_spec.json -p designspec.json -o . --diff --no-qa --json`, { 
            cwd: root, 
            encoding: "utf-8"
          });

          await fs.remove(remoteSpecFile);

          let diffData;
          try {
            diffData = JSON.parse(output.substring(output.indexOf('{')));
          } catch (e) {
            throw new Error(`Failed to parse diff output: ${output}`);
          }

          const created = diffData.results.created.length;
          const updated = diffData.results.updated.length;
          const skipped = diffData.results.skipped.length;
          
          const changedFiles = [...diffData.results.created, ...diffData.results.updated].slice(0, 10);

          return { 
            jsonrpc: "2.0", 
            id, 
            result: { 
              content: [{ 
                type: "text", 
                text: `🔍 **DIFF PREVIEW** (${diffData.mode})\n\n- Files to create: **${created}**\n- Files to update: **${updated}**\n- Files unchanged: **${skipped}**\n\n**Impacted Areas:**\n${diffData.deltas.map(d => `- ${d.type}${d.domainKey ? ': ' + d.domainKey : ''}`).join("\n")}\n\n**Example changes:**\n${changedFiles.map(f => `- ${f}`).join("\n")}${changedFiles.length >= 10 ? "\n- ..." : ""}` 
              }],
              structuredContent: {
                diffResult: diffData
              }
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
          { 
            name: "archon_read_local_lineage", 
            description: "Read the local lineage manifest. Use this to find the projectId and current revisionId before initiating architectural changes.", 
            inputSchema: { type: "object", properties: {} } 
          },
          { 
            name: "archon_verify_local", 
            description: "Verify local code integrity against the lineage manifest. Ensures no unauthorized drift occurred.", 
            inputSchema: { type: "object", properties: {} } 
          },
          { 
            name: "archon_diff_local", 
            description: "Preview architectural changes before applying them. Recommended before running sync.", 
            inputSchema: { type: "object", properties: {} } 
          },
          { 
            name: "archon_sync_local", 
            description: "PREFERRED SYNC METHOD: Final step of architectural evolution. Fetches the latest approved DesignSpec from the remote server and regenerates local code while preserving all manual regions (comment-based) and @ArchonManual() decorated methods. Requires a clean Git workspace.",
            inputSchema: { 
              type: "object", 
              properties: { 
                projectId: { type: "string", description: "The permanent project ID from lineage.json" },
                allowDirtyWorkspace: { type: "boolean", description: "Bypass Git safety check (not recommended)" }
              } 
            } 
          },
          {
            name: "archon_sync_via_artifact",
            description: "SMART ARTIFACT SYNC: Downloads a generation ZIP artifact and performs a region-aware merge into the current workspace. Preserves all manual code blocks (// @archon-manual-start) and @ArchonManual() decorated methods. Use this if the spec-driven flow fails or to synchronize with a remote build while keeping local customizations.",
            inputSchema: {
              type: "object",
              properties: {
                artifactUrl: { type: "string", description: "The pre-signed S3 download URL for the project ZIP" }
              },
              required: ["artifactUrl"]
            }
          }
        );

        // PHASE FILTERING
        if (!hasProject) {
          responseJson.result.tools = responseJson.result.tools.filter(t => 
            !["archon_add_domain", "archon_add_entity", "archon_patch_spec", "archon_sync_local", "archon_diff_local", "archon_verify_local", "archon_read_local_lineage", "archon_sync_via_artifact"].includes(t.name)
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
