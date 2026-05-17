---
name: copilot-instructions-blueprint-generator
description: 'Technology-agnostic blueprint generator for creating comprehensive copilot-instructions.md files that guide GitHub Copilot to produce code consistent with project standards, architecture patterns, and exact technology versions by analyzing existing codebase patterns and avoiding assumptions.'
---

# Copilot Instructions Blueprint Generator

Technology-agnostic blueprint generator for creating comprehensive copilot-instructions.md files that guide GitHub Copilot to produce code consistent with project standards, architecture patterns, and exact technology versions by analyzing existing codebase patterns and avoiding assumptions.

## Configuration Variables

- `PROJECT_TYPE` - Auto-detect|.NET|Java|JavaScript|TypeScript|React|Angular|Python|Multiple|Other
- `ARCHITECTURE_STYLE` - Layered|Microservices|Monolithic|Domain-Driven|Event-Driven|Serverless|Mixed
- `CODE_QUALITY_FOCUS` - Maintainability|Performance|Security|Accessibility|Testability|All
- `DOCUMENTATION_LEVEL` - Minimal|Standard|Comprehensive
- `TESTING_REQUIREMENTS` - Unit|Integration|E2E|TDD|BDD|All
- `VERSIONING` - Semantic|CalVer|Custom

## Generated Prompt Template

Use this skill to analyze your codebase and generate a comprehensive copilot-instructions.md file that:

1. Detects exact technology versions
2. Documents architectural patterns
3. Catalogs coding standards
4. Captures testing approaches
5. Ensures consistency with existing code

The generated instructions will guide GitHub Copilot to:
- Respect exact versions of languages, frameworks, and libraries
- Follow established patterns in your codebase
- Maintain architectural consistency
- Apply appropriate quality standards
- Match your documentation and testing styles
