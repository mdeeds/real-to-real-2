export class FileScanner {
    /**
     * Filters a FileList for audio files and logs their details.
     * @param {FileList} fileList 
     */
    scanAndLog(fileList) {
        const audioFiles = Array.from(fileList).filter(file =>
            file.name.toLowerCase().endsWith('.wav') || file.name.toLowerCase().endsWith('.mp3')
        );

        if (audioFiles.length > 0) {
            console.log(`Found ${audioFiles.length} audio files (.wav, .mp3) in the selected folder.`);
            console.log('---------------------------------------');

            for (const file of audioFiles) {
                console.log(`File: ${file.name}, Size: ${file.size} bytes, Last Modified: ${new Date(file.lastModified).toLocaleString()}`);
            }
        } else {
            console.log('No .wav or .mp3 files found in the selected folder.');
        }
    }
}