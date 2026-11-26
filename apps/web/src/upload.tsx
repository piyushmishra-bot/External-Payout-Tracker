import { Icon } from './ui';

export const MAX_FILES = 5;
export const ACCEPT = 'application/pdf,.pdf,.xlsx,.csv,text/csv,image/*';

/**
 * A button that IS the file input (a <label> around it). Phones only open the picker
 * on a direct tap of the input, so we never call input.click() from code.
 * Note for the native app: an Android WebView must implement
 * WebChromeClient.onShowFileChooser, or no file input will open there.
 */
export function UploadButton({
  label,
  className = 'btn btn-primary',
  onFiles,
  icon = true,
  accept = ACCEPT,
  multiple = true,
  track,
}: {
  label: string;
  className?: string;
  onFiles: (files: File[]) => void;
  icon?: boolean;
  accept?: string;
  multiple?: boolean;
  /** Click id for the admin page (data-track). */
  track?: string;
}) {
  return (
    <label className={`${className} file-btn`} data-track={track}>
      {icon && <Icon name="upload-cloud-2-line" size={18} />}
      {label}
      <input
        className="file-input"
        type="file"
        multiple={multiple}
        accept={accept}
        aria-label={label}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (!files.length) return;
          onFiles(files);
        }}
      />
    </label>
  );
}

