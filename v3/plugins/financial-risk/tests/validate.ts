/**
 * Financial Risk Plugin - Validation Script
 * Validates that all MCP tools work correctly with test data.
 */

import {
  financialTools,
  portfolioRiskTool,
  anomalyDetectTool,
  marketRegimeTool,
  complianceCheckTool,
  stressTestTool,
  toolHandlers,
} from '../dist/mcp-tools.js';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';

interface ValidationResult {
  tool: string;
  passed: boolean;
  error?: string;
}

async function validateTool(
  name: string,
  handler: (input: Record<string, unknown>, context?: unknown) => Promise<{ success: boolean; data?: unknown; error?: string }>,
  input: Record<string, unknown>
): Promise<ValidationResult> {
  try {
    const result = await handler(input);

    if (!result.success && result.error) {
      return { tool: name, passed: false, error: result.error };
    }

    if (typeof result !== 'object') {
      return { tool: name, passed: false, error: 'Result is not an object' };
    }

    return { tool: name, passed: true };
  } catch (err) {
    return { tool: name, passed: false, error: String(err) };
  }
}

async function main() {
  console.log('Financial Risk Plugin - MCP Tools Validation\n');
  console.log('='.repeat(60));

  const results: ValidationResult[] = [];

  // 1. Portfolio Risk Tool
  console.log('\n1. Testing finance/portfolio-risk...');
  results.push(await validateTool(
    'finance/portfolio-risk',
    portfolioRiskTool.handler,
    {
      holdings: [
        { symbol: 'AAPL', quantity: 100, sector: 'Technology' },
        { symbol: 'GOOGL', quantity: 50, sector: 'Technology' },
        { symbol: 'JPM', quantity: 75, sector: 'Financials' },
      ],
      confidenceLevel: 0.95,
      horizon: '1d',
    }
  ));

  // 2. Anomaly Detection Tool
  console.log('2. Testing finance/anomaly-detect...');
  results.push(await validateTool(
    'finance/anomaly-detect',
    anomalyDetectTool.handler,
    {
      transactions: [
        { id: '550e8400-e29b-41d4-a716-446655440001', amount: 10000, timestamp: new Date().toISOString(), parties: ['acc1', 'merchant1'] },
        { id: '550e8400-e29b-41d4-a716-446655440002', amount: 150000, timestamp: new Date().toISOString(), parties: ['acc2', 'merchant2'] },
        { id: '550e8400-e29b-41d4-a716-446655440003', amount: 500, timestamp: new Date().toISOString(), parties: ['acc1', 'merchant3'] },
      ],
      sensitivity: 0.7,
      context: 'fraud',
    }
  ));

  // 3. Market Regime Tool
  console.log('3. Testing finance/market-regime...');
  results.push(await validateTool(
    'finance/market-regime',
    marketRegimeTool.handler,
    {
      marketData: {
        prices: [100, 101, 99, 102, 105, 103, 107, 110, 108, 112],
        volumes: [1000000, 1200000, 900000, 1100000, 1500000, 1300000, 1400000, 1600000, 1200000, 1800000],
        volatility: [0.15, 0.16, 0.14, 0.17, 0.18, 0.15, 0.19, 0.20, 0.17, 0.21],
      },
      lookbackPeriod: 20,
    }
  ));

  // 4. Compliance Check Tool
  console.log('4. Testing finance/compliance-check...');
  results.push(await validateTool(
    'finance/compliance-check',
    complianceCheckTool.handler,
    {
      entity: 'bank-123',
      regulations: ['basel3', 'aml'],
      scope: 'all',  // Valid options: 'positions', 'transactions', 'capital', 'reporting', 'all'
      asOfDate: new Date().toISOString().split('T')[0],
    }
  ));

  // 5. Stress Test Tool
  console.log('5. Testing finance/stress-test...');
  results.push(await validateTool(
    'finance/stress-test',
    stressTestTool.handler,
    {
      portfolio: {
        id: 'port-1',
        holdings: [
          { symbol: 'SPY', quantity: 500 },
          { symbol: 'TLT', quantity: 200 },
          { symbol: 'GLD', quantity: 100 },
        ],
      },
      scenarios: [
        { name: '2008 Crisis', type: 'historical', shocks: { equityShock: -0.4, rateShock: -0.02 } },
        { name: 'Rate Spike', type: 'hypothetical', shocks: { equityShock: -0.15, rateShock: 0.03 } },
      ],
    }
  ));

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('VALIDATION SUMMARY\n');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  for (const result of results) {
    console.log(`  ${result.passed ? PASS : FAIL} ${result.tool}`);
    if (result.error) {
      console.log(`      Error: ${result.error.slice(0, 100)}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log('Exported tools:', financialTools.length);
  console.log('Handler map size:', toolHandlers.size);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Validation failed:', err);
  process.exit(1);
});
