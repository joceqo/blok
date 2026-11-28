import {
  Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text,
} from '@react-email/components';

/**
 * The workspace invitation. {{#message}}…{{/message}} wraps the optional note
 * from the administrator: the services drop the whole block when there is no
 * message, so the heading never shows above an empty note.
 */
export default function Invitation() {
  return (
    <Html lang="fr">
      <Head />
      <Preview>Rejoignez {'{{workspace}}'} sur Blok</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={heading}>Vous êtes invité à rejoindre {'{{workspace}}'}</Heading>
          <Text style={paragraph}>
            Connectez-vous avec cette adresse e-mail pour accepter l’invitation.
            Elle expire dans sept jours.
          </Text>
          <Section style={{ margin: '0 0 24px' }}>
            <Button href={'{{publicURL}}'} style={button}>
              Accepter l’invitation
            </Button>
          </Section>
          {'{{#message}}'}
          <Section style={note}>
            <Text style={noteLabel}>Message de l’administrateur</Text>
            <Text style={noteBody}>{'{{message}}'}</Text>
          </Section>
          {'{{/message}}'}
          <Hr style={rule} />
          <Text style={footer}>{'{{publicURL}}'}</Text>
        </Container>
      </Body>
    </Html>
  );
}

const body = { backgroundColor: '#f6f6f7', margin: 0, padding: '32px 0', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' };
const container = { backgroundColor: '#ffffff', border: '1px solid #e8e8ea', borderRadius: '10px', margin: '0 auto', maxWidth: '456px', padding: '36px 40px' };
const heading = { color: '#1a1a1a', fontSize: '21px', fontWeight: 600, lineHeight: '28px', margin: '0 0 18px' };
const paragraph = { color: '#4a4a4f', fontSize: '15px', lineHeight: '24px', margin: '0 0 22px' };
const button = { backgroundColor: '#1a1a1a', borderRadius: '7px', color: '#ffffff', display: 'inline-block', fontSize: '15px', fontWeight: 600, padding: '12px 22px', textDecoration: 'none' };
const note = { borderLeft: '3px solid #e8e8ea', margin: '0 0 22px', padding: '2px 0 2px 16px' };
const noteLabel = { color: '#8a8a90', fontSize: '12px', fontWeight: 600, letterSpacing: '0.4px', margin: '0 0 6px', textTransform: 'uppercase' as const };
const noteBody = { color: '#4a4a4f', fontSize: '15px', lineHeight: '23px', margin: 0, whiteSpace: 'pre-line' as const };
const rule = { borderColor: '#e8e8ea', margin: '26px 0 16px' };
const footer = { color: '#8a8a90', fontSize: '13px', lineHeight: '18px', margin: 0 };
