---
name: sql-optimization
description: 'Universal SQL performance optimization assistant for comprehensive query tuning, indexing strategies, and database performance analysis across all SQL databases (MySQL, PostgreSQL, SQL Server, Oracle, SQLite). Provides execution plan analysis, pagination optimization, batch operations, and performance monitoring guidance.'
---

# SQL Performance Optimization

Expert SQL performance optimization for universal SQL databases including SQLite, MySQL, PostgreSQL, SQL Server, and Oracle.

## Core Optimization Areas

### Query Performance Analysis
```sql
-- ❌ BAD: Inefficient query patterns
SELECT * FROM orders WHERE YEAR(created_at) = 2024;

-- ✅ GOOD: Optimized with proper indexing
SELECT id, customer_id, total_amount, created_at
FROM orders
WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01';
```

### Index Strategy Optimization
```sql
-- ❌ BAD: Poor indexing strategy
CREATE INDEX idx_all ON users(email, first_name, last_name, created_at);

-- ✅ GOOD: Targeted composite indexes
CREATE INDEX idx_users_email_created ON users(email, created_at);
CREATE INDEX idx_users_name ON users(last_name, first_name);
```

### Subquery Optimization
```sql
-- ❌ BAD: Correlated subquery
SELECT p.name FROM products p
WHERE p.price > (SELECT AVG(price) FROM products WHERE category_id = p.category_id);

-- ✅ GOOD: Window function approach
SELECT name, price FROM (
  SELECT name, price, AVG(price) OVER (PARTITION BY category_id) as avg_price
  FROM products
) WHERE price > avg_price;
```

## Performance Tuning Techniques

### JOIN Optimization
- Filter early with WHERE conditions
- Use INNER JOIN when appropriate (more efficient than LEFT JOIN)
- Join on indexed columns
- Order JOINs from smallest to largest table

### Pagination Optimization
```sql
-- ❌ BAD: OFFSET-based (slow for large offsets)
SELECT * FROM products ORDER BY id LIMIT 20 OFFSET 10000;

-- ✅ GOOD: Cursor-based pagination
SELECT * FROM products WHERE id > 1000 ORDER BY id LIMIT 20;
```

### Aggregation Optimization
```sql
-- ❌ BAD: Multiple separate queries
SELECT COUNT(*) FROM orders WHERE status = 'pending';
SELECT COUNT(*) FROM orders WHERE status = 'shipped';

-- ✅ GOOD: Single query with conditional aggregation
SELECT 
  COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
  COUNT(CASE WHEN status = 'shipped' THEN 1 END) as shipped
FROM orders;
```

## Query Anti-Patterns

### SELECT Performance Issues
```sql
-- ❌ BAD: SELECT * anti-pattern
SELECT * FROM large_table;

-- ✅ GOOD: Explicit column selection
SELECT id, name, created_at FROM large_table;
```

### WHERE Clause Optimization
```sql
-- ❌ BAD: Function calls prevent index usage
SELECT * FROM orders WHERE UPPER(email) = 'TEST@EXAMPLE.COM';

-- ✅ GOOD: Index-friendly WHERE clause
SELECT * FROM orders WHERE email = 'test@example.com';
```

## Database-Agnostic Best Practices

### Batch Operations
```sql
-- ❌ BAD: Row-by-row inserts
INSERT INTO products (name, price) VALUES ('A', 10);
INSERT INTO products (name, price) VALUES ('B', 20);

-- ✅ GOOD: Batch insert
INSERT INTO products (name, price) VALUES ('A', 10), ('B', 20);
```

### Temporary Tables for Complex Operations
```sql
CREATE TEMPORARY TABLE temp_calc AS
SELECT customer_id, SUM(total) as total_spent
FROM orders WHERE created_at >= '2024-01-01'
GROUP BY customer_id;

SELECT c.name, tc.total_spent
FROM temp_calc tc JOIN customers c ON tc.customer_id = c.id;
```

## Universal Optimization Checklist

### Query Structure
- [ ] Avoid SELECT * in production queries
- [ ] Use appropriate JOIN types
- [ ] Filter early in WHERE clauses
- [ ] Use EXISTS instead of IN for subqueries when appropriate
- [ ] Avoid functions in WHERE clauses that prevent index usage

### Index Strategy
- [ ] Create indexes on frequently queried columns
- [ ] Use composite indexes in correct column order
- [ ] Avoid over-indexing (impacts INSERT/UPDATE)
- [ ] Use covering indexes where beneficial
- [ ] Consider partial indexes for specific patterns

### Data Types and Schema
- [ ] Use appropriate data types for storage efficiency
- [ ] Normalize appropriately
- [ ] Use constraints to help query optimizer
- [ ] Partition large tables when appropriate

### Query Patterns
- [ ] Use LIMIT/TOP for result set control
- [ ] Implement efficient pagination
- [ ] Use batch operations for bulk changes
- [ ] Avoid N+1 query problems
- [ ] Use prepared statements for repeated queries

### Performance Testing
- [ ] Test with realistic data volumes
- [ ] Analyze query execution plans
- [ ] Monitor performance over time
- [ ] Set up alerts for slow queries
- [ ] Regular index usage analysis

## Optimization Methodology

1. **Identify**: Find slow queries using database-specific tools
2. **Analyze**: Examine execution plans and identify bottlenecks
3. **Optimize**: Apply appropriate optimization techniques
4. **Test**: Verify performance improvements with realistic data
5. **Monitor**: Continuously track performance metrics
6. **Iterate**: Regular performance review and optimization

Focus on measurable performance improvements and always test optimizations with realistic data volumes.
