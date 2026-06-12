'use client';

import React from 'react';
import styles from './ReasoningSummary.module.css';

export default function ReasoningSummary({ activeAgentName = 'Deployment Agent', data = null }: { activeAgentName?: string, data?: any }) {
  // If data is passed, use it, else use default mock
  const summaryData = data ? [
    { label: 'Goal', value: data.goal },
    { label: 'Constraints', value: data.constraints },
    { label: 'Decision', value: data.decision },
    { label: 'Trade-off', value: data.tradeoff },
    { label: 'Next Action', value: data.nextAction, isNextAction: true }
  ] : [
    { label: 'Goal', value: 'Deploy Next.js app with automatic rollback.' },
    { label: 'Constraints', value: 'Zero downtime, local Docker environment, minimal configuration.' },
    { label: 'Decision', value: 'Use blue-green deployment with health checks.' },
    { label: 'Trade-off', value: 'Slightly higher resource usage for safer deployments.' },
    { label: 'Next Action', value: 'Execute health verification checks.', isNextAction: true }
  ];

  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className={styles.header}>
        <h2 className="section-title">
          <span className={styles.pulseIcon}></span>
          {activeAgentName} — Reasoning
        </h2>
      </div>
      
      <div className={styles.content}>
        {summaryData.map((item, index) => (
          <div 
            key={item.label} 
            className={`${styles.item} animate-fade-in`} 
            style={{ animationDelay: `${index * 0.15}s` }}
          >
            <span className={styles.label}>{item.label}:</span>
            <span className={`${styles.value} ${item.isNextAction ? styles.highlight : ''}`}>
              {item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
