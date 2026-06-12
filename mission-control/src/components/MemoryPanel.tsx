'use client';

import React from 'react';
import styles from './MemoryPanel.module.css';

export default function MemoryPanel() {
  const memoryItems = [
    { key: 'Project Type', value: 'SaaS' },
    { key: 'Preferred Framework', value: 'Next.js' },
    { key: 'Database', value: 'PostgreSQL' },
    { key: 'Security Policy', value: 'Block critical vulnerabilities' },
    { key: 'Deployment Strategy', value: 'Blue-Green' },
  ];

  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className={styles.header}>
        <h2 className="section-title">Persistent Memory</h2>
      </div>
      
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <tbody>
            {memoryItems.map((item, index) => (
              <tr key={item.key} className={styles.row}>
                <td className={styles.keyCell}>{item.key}</td>
                <td className={styles.valueCell}>{item.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
