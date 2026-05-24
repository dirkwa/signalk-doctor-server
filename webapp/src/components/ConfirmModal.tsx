import { Button, Modal, ModalBody, ModalFooter, ModalHeader } from 'reactstrap';

interface Props {
  isOpen: boolean;
  title: string;
  body: string;
  okLabel?: string;
  okColor?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  isOpen,
  title,
  body,
  okLabel = 'OK',
  okColor = 'primary',
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal isOpen={isOpen} toggle={onCancel} backdrop="static" centered>
      <ModalHeader toggle={onCancel}>{title}</ModalHeader>
      <ModalBody>{body}</ModalBody>
      <ModalFooter>
        <Button color="secondary" outline onClick={onCancel}>
          Cancel
        </Button>
        <Button color={okColor} onClick={onConfirm}>
          {okLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
