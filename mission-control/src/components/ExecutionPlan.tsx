'use client';

import React from 'react';
import styles from './ExecutionPlan.module.css';

const steps = [
  { id: 1, title: 'Create repository structure', detail: 'Frontend • API • CI/CD', status: 'completed' },
  { id: 2, title: 'Generate Next.js frontend', detail: 'App Router, CSS, auth pages', status: 'completed' },
  { id: 3, title: 'Create API endpoints', detail: 'Auth, billing, analytics', status: 'completed' },
  { id: 4, title: 'Run security scan', detail: 'Dependencies, secrets, containers', status: 'completed' },
  { id: 5, title: 'Execute tests', detail: 'Unit, integration, smoke', status: 'completed' },
  { id: 6, title: 'Deploy canary release', detail: '5% traffic for 10 minutes', status: 'active' },
  { id: 7, title: 'Promote to production', detail: 'Rollback automatically on failures', status: 'pending' },
];

export default function ExecutionPlan() {
  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className={styles.header}>
        <h2 className="section-title">Execution Plan</h2>
        <span className={styles.subtitle}>Project: Secure SaaS Landing Page</span>
        <span className={styles.badge}>Auto-generated</span>
      </div>
      
      <div className={styles.timeline}>
        {steps.map((step) => (
          <div key={step.id} className={`${styles.step} ${styles[step.status]}`}>
            <div className={styles.nodeWrapper}>
              <div className={styles.node}>
                {step.status === 'completed' && '✓'}
                {step.status === 'active' && <div className={styles.activeDot}></div>}
              </div>
              {step.id < steps.length && <div className={styles.line}></div>}
            </div>
            <div className={styles.content}>
              <h3 className={styles.title}>{step.id}. {step.title}</h3>
              <p className={styles.detail}>{step.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
