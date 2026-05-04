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

class ApprovalRules {
  constructor(rulesPath) {
    this.rules = this.loadRules(rulesPath);
  }

  loadRules(filePath) {
    const raw = yaml.load(fs.readFileSync(filePath, 'utf8'));
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
        try { new RegExp(rule.command_pattern); }
        catch (e) { throw new Error(`Rule regex compilation failed: ${e.message}`); }
      }
    }
    return raw.rules;
  }

  match(toolName, context = {}) {
    for (const rule of this.rules) {
      if (rule.tool !== toolName && rule.tool !== '*') continue;

      if (rule.command_pattern && context.command) {
        const regex = new RegExp(rule.command_pattern);
        if (!regex.test(context.command)) continue;
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

module.exports = { ApprovalRules, hasNestedQuantifiers, hasBackReference };