import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: 'Helvetica',
    color: '#1e293b',
    lineHeight: 1.5
  },
  header: {
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    paddingBottom: 10
  },
  title: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: '#0f172a',
    textTransform: 'uppercase'
  },
  subtitle: {
    fontSize: 9,
    color: '#64748b',
    marginTop: 2
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    marginTop: 12,
    marginBottom: 4,
    color: '#0f172a'
  },
  paragraph: {
    marginBottom: 8,
    textAlign: 'justify'
  },
  auditBox: {
    marginTop: 24,
    padding: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0'
  },
  auditHeader: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: '#0369a1',
    marginBottom: 8,
    textTransform: 'uppercase',
    borderBottomWidth: 0.5,
    borderBottomColor: '#bae6fd',
    paddingBottom: 4
  },
  auditGrid: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap'
  },
  auditCol: {
    width: '50%',
    marginBottom: 6
  },
  auditLabel: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: '#64748b',
    textTransform: 'uppercase'
  },
  auditValue: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
    color: '#0f172a',
    marginTop: 1
  },
  signatureBox: {
    marginTop: 20,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 12
  },
  typedSignature: {
    fontSize: 16,
    fontFamily: 'Times-Italic',
    color: '#0f172a',
    marginTop: 4
  }
});

export interface NdaAuditData {
  fullName: string;
  email: string;
  typedSignature: string;
  signedAt: Date | string;
  ipAddress: string;
  userAgent: string;
  version: string;
  userId: string;
}

export const NdaPdfDocument: React.FC<{ data: NdaAuditData }> = ({ data }) => {
  const formattedDate = new Date(data.signedAt).toUTCString();

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>BETA CONFIDENTIALITY AGREEMENT</Text>
          <Text style={styles.subtitle}>
            T-Dagsis LLC • Sovereign Platform Beta • Version {data.version}
          </Text>
        </View>

        <Text style={styles.paragraph}>
          This Beta Confidentiality and Non-Disclosure Agreement ("Agreement") is entered into and made effective as of the execution timestamp recorded below, by and between T-Dagsis LLC ("Company") and the undersigned Beta Participant ("Recipient").
        </Text>

        <Text style={styles.sectionTitle}>1. Proprietary Information</Text>
        <Text style={styles.paragraph}>
          Recipient understands that Company possesses valuable, confidential, and proprietary technical information, financial allocation algorithms, bucket management workflows, and software interfaces ("Proprietary Information"). Recipient agrees to hold all Proprietary Information in strict confidence and shall not reverse engineer, record, screenshot, or disclose any portion to third parties.
        </Text>

        <Text style={styles.sectionTitle}>2. Term and Binding Nature</Text>
        <Text style={styles.paragraph}>
          This Agreement remains binding throughout Recipient's participation in the Sovereign Beta program and survives termination of access for a period of five (5) years.
        </Text>

        <View style={styles.signatureBox}>
          <Text style={styles.auditLabel}>ELECTRONIC SIGNATURE</Text>
          <Text style={styles.typedSignature}>/s/ {data.typedSignature}</Text>
          <Text style={styles.auditValue}>
            {data.fullName} ({data.email})
          </Text>
        </View>

        <View style={styles.auditBox}>
          <Text style={styles.auditHeader}>
            {'\u2713'} Legally Verified Electronic Signature Audit Record
          </Text>
          <View style={styles.auditGrid}>
            <View style={styles.auditCol}>
              <Text style={styles.auditLabel}>Signer Identity</Text>
              <Text style={styles.auditValue}>{data.fullName}</Text>
            </View>
            <View style={styles.auditCol}>
              <Text style={styles.auditLabel}>Server UTC Timestamp</Text>
              <Text style={styles.auditValue}>{formattedDate}</Text>
            </View>
            <View style={styles.auditCol}>
              <Text style={styles.auditLabel}>Verified IP Address</Text>
              <Text style={styles.auditValue}>{data.ipAddress}</Text>
            </View>
            <View style={styles.auditCol}>
              <Text style={styles.auditLabel}>NDA Version</Text>
              <Text style={styles.auditValue}>{data.version}</Text>
            </View>
            <View style={{ width: '100%', marginTop: 4 }}>
              <Text style={styles.auditLabel}>User-Agent Hardware Metadata</Text>
              <Text style={styles.auditValue}>{data.userAgent}</Text>
            </View>
            <View style={{ width: '100%', marginTop: 4 }}>
              <Text style={styles.auditLabel}>Audit ID / User Key</Text>
              <Text style={styles.auditValue}>{data.userId}</Text>
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
};
