/**
 * Agent Arena - Entry Point
 *
 * Re-exports from main.ts using the Values & Boundaries architecture.
 *
 * Usage:
 *   npm run dev          # Development with hot reload
 *   npm run serve        # Run directly with tsx
 *   npm run build        # Build TypeScript
 *   npm start            # Run built JavaScript
 */

// Re-export everything from main entry point
export * from './main.js';

// If this file is executed directly, run main
import('./main.js').catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
