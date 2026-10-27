import { NOTE, NOTE_STRONG } from './styles.ts'

// The note under the cards (prd-02 Ruling 5). Divvy cannot move money: a
// contribution records a transfer Hannah makes herself, and the savings
// account it lands in is outside safe-to-spend. The prototype's footer
// names the account contributions come from; goals carry no account, so
// that line is not shown.
export default function RecordNote() {
  return (
    <p className={NOTE}>
      Contributions are{' '}
      <strong className={NOTE_STRONG}>records of a transfer you make yourself</strong>.
      Divvy doesn&apos;t move money, and recording one doesn&apos;t change
      safe-to-spend.
    </p>
  )
}
