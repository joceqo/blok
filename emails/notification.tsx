import {
  Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text,
} from '@react-email/components';

/**
 * One message for every notification type: the service writes the headline
 * and the sentence, so a new type needs no new template.
 */
export default function Notification() {
  return (
    <Html lang="fr">
      <Head />
      <Preview>{'{{headline}}'}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Text style={eyebrow}>{'{{workspace}}'}</Text>
          <Heading style={heading}>{'{{headline}}'}</Heading>
          <Text style={paragraph}>{'{{detail}}'}</Text>
          <Section style={{ margin: '0 0 24px' }}>
            <Button href={'{{link}}'} style={button}>
              Ouvrir dans Blok
            </Button>
          </Section>
          <Hr style={rule} />
          <Text style={footer}>
            Vous recevez cet e-mail parce que vous avez activé les
            notifications par e-mail pour cet espace de travail.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const body = { backgroundColor: '#f6f6f7', margin: 0, padding: '32px 0', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' };
const container = { backgroundColor: '#ffffff', border: '1px solid #e8e8ea', borderRadius: '10px', margin: '0 auto', maxWidth: '456px', padding: '36px 40px' };
const eyebrow = { color: '#8a8a90', fontSize: '12px', fontWeight: 600, letterSpacing: '0.4px', margin: '0 0 10px', textTransform: 'uppercase' as const };
const heading = { color: '#1a1a1a', fontSize: '21px', fontWeight: 600, lineHeight: '28px', margin: '0 0 14px' };
const paragraph = { color: '#4a4a4f', fontSize: '15px', lineHeight: '24px', margin: '0 0 22px' };
const button = { backgroundColor: '#1a1a1a', borderRadius: '7px', color: '#ffffff', display: 'inline-block', fontSize: '15px', fontWeight: 600, padding: '12px 22px', textDecoration: 'none' };
const rule = { borderColor: '#e8e8ea', margin: '26px 0 16px' };
const footer = { color: '#8a8a90', fontSize: '13px', lineHeight: '19px', margin: 0 };
