'use client';

import React from 'react';
import styles from './InfrastructureBar.module.css';

const containers = [
  { name: 'app-container-1', status: 'ok' },
  { name: 'app-container-2', status: 'ok' },
  { name: 'postgres', status: 'ok' },
  { name: 'redis', status: 'ok' },
  { name: 'cdn', status: 'ok' },
  { name: 'gateway', status: 'ok' },
];

export default function InfrastructureBar() {
  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <span className={styles.label}>PRODUCTION ENVIRONMENT</span>
        <div className={styles.containerList}>
          {containers.map(c => (
            <div key={c.name} className={styles.containerPill}>
              {c.name} <span className={styles[c.status]}>●</span>
            </div>
          ))}
        </div>
      </div>
      
      <div className={`${styles.metrics} mono`}>
        <span>CPU 34% <span className={styles.barVisual}><span style={{ width: '34%' }}></span></span></span>
        <span>MEM 61% <span className={styles.barVisual}><span style={{ width: '61%' }}></span></span></span>
        <span>LATENCY p99: 142ms</span>
        <span>UPTIME 99.97%</span>
        <span className={styles.sysOk}>↑ All Systems Nominal</span>
      </div>
    </div>
  );
}
