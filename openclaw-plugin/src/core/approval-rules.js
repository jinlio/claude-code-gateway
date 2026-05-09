// ApprovalRules — YAML-based approval rule engine with regex safety
// See: cc-bridge-v3-final-plan.md Section 4

const fs = require('fs');
const yaml = require('js-yaml');
const { minimatch } = require('minimatch');

function hasNestedQuantifiers(pattern) {
  const groupQuantifier = /\([^)]*[+*{][^)]*\)[+*{]/;
  return groupQuantifier.test(pattern);
}

function hasBackReference(pattern) {
  return /\\[1-9]/.test(pattern);
}

function hasOverlappingAlternation(pattern) {
  // Detect alternation-based catastrophic backtracking like (a|a)+
  // Finds grouped quantified alternations (...|...)+ or (...|...)*
  // and checks whether branches share common prefixes.
  const groupAltQuant = /\(([^)]+)\)([+*{])/g;
  let match;
  while ((match = groupAltQuant.exec(pattern)) !== null) {
    const branches = match[1].split('|');
    if (branches.length < 2) continue;
    const prefixes = new Set();
    for (const branch of branches) {
      const b = branch.trim();
      if (b) prefixes.add(b[0]);
    }
    // If multiple branches share the same first character, overlap exists
    if (prefixes.size < branches.length) return true;
  }
  return false;
}

class ApprovalRules {
  constructor(rulesPath) {
    this.rules = this.loadRules(rulesPath);
  }

  loadRules(filePath) {
    // js-yaml 4.x: yaml.load() is safe by default (DEFAULT_SCHEMA removed unsafe tags)
    // Explicitly pass SAFE_SCHEMA for additional belt-and-suspenders safety
    const raw = yaml.load(fs.readFileSync(filePath, 'utf8'), { schema: yaml.SAFE_SCHEMA });
    for (const rule of raw.rules) {
      if (rule.command_pattern) {
        if (rule.command_pattern.length > 100) {
          throw new Error(`Rule regex too long (>100): ${rule.command_pattern}`);
        }
        if (hasNestedQuantifiers(rule.command_pattern)) {
          throw new Error(`Rule regex has nested quantifiers: ${rule.command_pattern}`);
        }
        if (hasBackReference(rule.command_pattern)) {
          throw new Error(`Rule regex has back references: ${rule.command_pattern}`);
        }
        if (hasOverlappingAlternation(rule.command_pattern)) {
          throw new Error(`Rule regex has overlapping alternation: ${rule.command_pattern}`);
        }
        try {
          rule._compiledRegex = new RegExp(rule.command_pattern);
        } catch (e) { throw new Error(`Rule regex compilation failed: ${e.message}`); }
      }
    }
    return raw.rules;
  }

  match(toolName, context = {}) {
    for (const rule of this.rules) {
      if (rule.tool !== toolName && rule.tool !== '*') continue;

      if (rule.command_pattern && context.command) {
        if (!rule._compiledRegex.test(context.command)) continue;
      }

      if (rule.path_pattern && context.filePath) {
        if (!minimatch(context.filePath, rule.path_pattern)) continue;
      }

      return {
        action: rule.action,
        sensitive: rule.sensitive || false
      };
    }
    return { action: 'require_approval', sensitive: false };
  }
}

module.exports = { ApprovalRules, hasNestedQuantifiers, hasBackReference, hasOverlappingAlternation };