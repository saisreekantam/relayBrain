'use client';

import React from 'react';
import styles from './TaskQueue.module.css';

export default function TaskQueue() {
  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className="section-title">
        TASK QUEUE <span className={styles.count}>[4 pending]</span>
      </div>

      <div className={styles.queueContainer}>
        <div className={styles.queueGroup}>
          <div className={`${styles.groupHeader} ${styles.activeHeader}`}>⟳ ACTIVE</div>
          <div className={styles.taskCard}>
            <div className={styles.taskTitle}>CVE patch verification</div>
            <div className={styles.taskMeta}>Security Agent • ~2m left</div>
          </div>
        </div>

        <div className={styles.queueGroup}>
          <div className={styles.groupHeader}>⏳ QUEUED</div>
          <div className={styles.taskCard}>
            <div className={styles.taskTitle}>Canary deployment (10%)</div>
            <div className={styles.taskMeta}>Deployment Agent</div>
          </div>
          <div className={styles.taskCard}>
            <div className={styles.taskTitle}>Smoke test suite</div>
            <div className={styles.taskMeta}>QA Agent</div>
          </div>
          <div className={styles.taskCard}>
            <div className={styles.taskTitle}>Notify stakeholders</div>
            <div className={styles.taskMeta}>CEO Agent</div>
          </div>
        </div>

        <div className={styles.queueGroup}>
          <div className={`${styles.groupHeader} ${styles.successHeader}`}>✓ COMPLETED TODAY (12)</div>
        </div>
      </div>
    </div>
  );
}
